"""滑块缺口识别：给定背景大图和滑块小图，返回需要滑动的横向像素 x。

MIIT 当前返回的滑块图并不是传统“拿小图去背景里做模板匹配”的格式：
背景图里的缺口区域已经被一块低饱和、低纹理的灰色遮罩覆盖，小图则是被挖走的
原图内容。因此直接用小图边缘做模板匹配，容易匹配到背景中相似纹理的位置，导致
``checkImage`` 返回“校验图片信息失败”。

识别顺序（从最鲁棒到最兜底）：
1. ``_detect_gap_by_box``：找“矩形边框”。灰色遮罩块无论背景是什么，都有四条
   又直又长的矩形边——这是天空/云/白色背景所没有的稳定特征。用积分图向量化地为
   每个候选位置打分 = 边框边缘能量 × 内部平坦度 × 内部灰度，取全局最优。这样即便
   背景是天空也能靠边框锁定缺口，解决旧“找灰色”算法在天空背景下与背景粘连的问题。
2. ``_detect_gap_by_gray_hole``：旧的“找灰色连通块”，深色背景下依然可靠，作为
   第二顺位。
3. ``_detect_gap_by_template``：Canny 边缘模板匹配，最后兜底，兼容旧样式图片。
"""
from __future__ import annotations

import logging

import cv2
import numpy as np


log = logging.getLogger(__name__)


# OpenCV 的 matchTemplate 需要模板尺寸不大于背景尺寸；同时滑块验证码通常不会
# 小到低于 20px。用作候选过滤，避免背景里零散的浅色区域被误判。
_MIN_SLIDER_SIZE = 20

# 经验值：MIIT 缺口块边长约 50~60px（背景大图约 500px 宽）。当小图裁剪异常
# 时用它兜底，并在几个候选尺寸上搜索，避免死依赖小图裁剪结果。
_DEFAULT_BOX = 55

# 打分归一化常数（可按实测微调）：
# _FLAT_K —— 内部灰度方差；平坦灰块方差通常 < 300，纹理背景可上千。
# _GRAY_K —— 内部三通道极差均值；灰块通常 < 15，彩色区域可达 40+。
_FLAT_K = 300.0
_GRAY_K = 25.0

# box 检测置信度阈值：峰值边框能量相对全图分布的 z 分数。低于此值认为没有清晰
# 矩形边框（可能识别不可靠），回退到灰洞法。实测后可调。
_BOX_BORDER_Z_MIN = 2.2


def _imdecode(data: bytes, flags: int):
    return cv2.imdecode(np.frombuffer(data, np.uint8), flags)


def _crop_slider(tp: np.ndarray) -> np.ndarray:
    """把滑块图裁剪到非透明的有效区域（去掉四周透明边）。"""
    if tp.ndim == 3 and tp.shape[2] == 4:
        alpha = tp[:, :, 3]
        ys, xs = np.where(alpha > 0)
        if len(xs) and len(ys):
            return tp[ys.min():ys.max() + 1, xs.min():xs.max() + 1, :3]
        return tp[:, :, :3]

    if tp.ndim == 3 and tp.shape[2] == 3:
        # 无 alpha：按非黑区域裁剪
        gray = cv2.cvtColor(tp, cv2.COLOR_BGR2GRAY)
        ys, xs = np.where(gray > 0)
        if len(xs) and len(ys):
            return tp[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    return tp


def _estimate_box_size(slider: np.ndarray) -> tuple[int, int] | None:
    """从滑块小图估计缺口块尺寸；裁剪异常（过细/过大/长宽比失衡）时返回 None。"""
    h, w = slider.shape[:2]
    if w < _MIN_SLIDER_SIZE or h < _MIN_SLIDER_SIZE:
        return None
    if w > 120 or h > 120:
        return None
    ratio = w / max(h, 1)
    if ratio < 0.6 or ratio > 1.7:
        return None
    return int(w), int(h)


def _score_boxes(gx_cum, gy_cum, ii, ii2, ii_spread,
                 width: int, height: int, w: int, h: int):
    """在固定框尺寸 (w,h) 下，向量化地为每个候选左上角打分，返回最优。

    返回 (score, x, y, border_z)：
    - score：综合分（边框能量归一 0.6 + 平坦度 0.25 + 灰度 0.15）
    - x, y：最优框左上角
    - border_z：峰值边框能量相对全图分布的 z 分数，用于置信度判定
    """
    ny, nx = height - h + 1, width - w + 1
    if ny <= 0 or nx <= 0:
        return None

    # 垂直边能量 V[y, x]：列 x 在行区间 [y, y+h) 内 |gx| 之和（gx_cum 带前导 0 行）
    v = gx_cum[h:height + 1, :] - gx_cum[0:height - h + 1, :]      # (ny, width)
    # 水平边能量 Hh[y, x]：行 y 在列区间 [x, x+w) 内 |gy| 之和（gy_cum 带前导 0 列）
    hh = gy_cum[:, w:width + 1] - gy_cum[:, 0:width - w + 1]       # (height, nx)

    left = v[:, 0:nx]
    right = v[:, w - 1:w - 1 + nx]
    top = hh[0:ny, :]
    bottom = hh[h - 1:h - 1 + ny, :]
    # 缺口块是“闭合矩形”，四条边都强；只有一条边强（如天空里的天际线横边）不算。
    # 因此用“最弱边”驱动打分，配合总能量做次要项，压制天空/天际线假阳性。
    border_min = np.minimum.reduce([left, right, top, bottom])     # (ny, nx)
    border_sum = left + right + top + bottom
    border = border_min * 3.0 + border_sum                        # (ny, nx)

    # 内部平坦度 & 灰度：向内缩 m 像素避开边框本身
    m = max(2, min(w, h) // 8)
    iw, ih = w - 2 * m, h - 2 * m

    def window(integral):
        return (integral[m + ih:m + ih + ny, m + iw:m + iw + nx]
                - integral[m:m + ny, m + iw:m + iw + nx]
                - integral[m + ih:m + ih + ny, m:m + nx]
                + integral[m:m + ny, m:m + nx])

    area = float(iw * ih)
    s = window(ii)
    sq = window(ii2)
    ss = window(ii_spread)
    mean = s / area
    var = np.maximum(sq / area - mean * mean, 0.0)
    spread_mean = ss / area

    flat = 1.0 / (1.0 + var / _FLAT_K)
    gray = 1.0 / (1.0 + spread_mean / _GRAY_K)

    border_norm = border / (float(border.max()) + 1e-6)
    score = border_norm * 0.6 + flat * 0.25 + gray * 0.15

    idx = int(np.argmax(score))
    y, x = divmod(idx, nx)

    b_mean = float(border.mean())
    b_std = float(border.std()) + 1e-6
    border_z = (float(border[y, x]) - b_mean) / b_std
    return float(score[y, x]), int(x), int(y), float(border_z)


def _detect_gap_by_box(bg: np.ndarray, size_hint: tuple[int, int] | None):
    """通过“矩形边框 + 内部平坦/灰度”定位缺口块，返回 (x, border_z) 或 None。"""
    height, width = bg.shape[:2]
    grayf = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY).astype(np.float64)

    gx = np.abs(cv2.Sobel(grayf, cv2.CV_64F, 1, 0, ksize=3))
    gy = np.abs(cv2.Sobel(grayf, cv2.CV_64F, 0, 1, ksize=3))

    # 带前导 0 的累积和，便于 O(1) 取任意行/列区间和
    gx_cum = np.zeros((height + 1, width), np.float64)
    gx_cum[1:] = np.cumsum(gx, axis=0)
    gy_cum = np.zeros((height, width + 1), np.float64)
    gy_cum[:, 1:] = np.cumsum(gy, axis=1)

    ii, ii2 = cv2.integral2(grayf)  # (H+1, W+1)
    b, g, r = cv2.split(bg.astype(np.float64))
    spread = np.maximum.reduce([b, g, r]) - np.minimum.reduce([b, g, r])
    ii_spread = cv2.integral(spread)

    # 候选尺寸：小图估计值优先，附带默认边长附近几档，覆盖尺寸估计偏差
    sizes: list[tuple[int, int]] = []
    if size_hint:
        sizes.append(size_hint)
    for s in (_DEFAULT_BOX, _DEFAULT_BOX - 8, _DEFAULT_BOX + 8):
        sizes.append((s, s))

    seen: set[tuple[int, int]] = set()
    best = None  # (score, x, y, w, h, border_z)
    for w, h in sizes:
        if (w, h) in seen:
            continue
        seen.add((w, h))
        if w + 2 >= width or h + 2 >= height:
            continue
        res = _score_boxes(gx_cum, gy_cum, ii, ii2, ii_spread,
                           width, height, w, h)
        if res is None:
            continue
        score, x, y, border_z = res
        if best is None or score > best[0]:
            best = (score, x, y, w, h, border_z)

    if best is None:
        log.debug("矩形边框：无有效候选尺寸")
        return None

    score, x, y, w, h, border_z = best
    if border_z < _BOX_BORDER_Z_MIN:
        log.debug("矩形边框：边框置信度不足 z=%.2f(<%.2f) score=%.2f x=%d "
                  "wh=%dx%d，回退灰洞法", border_z, _BOX_BORDER_Z_MIN,
                  score, x, w, h)
        return None
    log.debug("矩形边框：命中 x=%d y=%d wh=%dx%d score=%.2f z=%.2f",
              x, y, w, h, score, border_z)
    return x, border_z


def _component_candidates(mask: np.ndarray, tw: int, th: int):
    """从二值 mask 中找尺寸接近滑块的连通块。"""
    num, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, 8)
    slider_area = tw * th
    for i in range(1, num):
        x, y, w, h, area = stats[i]
        if area < slider_area * 0.45:
            continue
        if not (tw * 0.75 <= w <= tw * 1.30):
            continue
        if not (th * 0.75 <= h <= th * 1.30):
            continue

        fill_ratio = area / max(w * h, 1)
        dim_diff = abs(w - tw) / tw + abs(h - th) / th
        area_diff = abs(area - slider_area) / slider_area

        # 缺口块一般是一个填充度很高、尺寸与滑块接近的矩形区域。
        # 分数越大越可信。
        score = fill_ratio * 2.0 - dim_diff * 1.2 - area_diff * 0.4
        yield float(score), int(x), int(y), int(w), int(h), int(area)


def _detect_gap_by_gray_hole(bg: np.ndarray, slider: np.ndarray) -> int | None:
    """定位背景图中灰色缺口块的左边界。

    MIIT 的背景图会用一块近似纯灰色区域覆盖缺口。这个区域具有：
    - HSV 饱和度低；
    - RGB 三通道差值小；
    - 亮度中高；
    - 尺寸接近滑块小图。
    """
    th, tw = slider.shape[:2]
    if tw < _MIN_SLIDER_SIZE or th < _MIN_SLIDER_SIZE:
        log.debug("灰色缺口：滑块过小 %dx%d(<%d)，跳过灰洞检测",
                  tw, th, _MIN_SLIDER_SIZE)
        return None
    if bg.shape[1] < tw or bg.shape[0] < th:
        log.debug("灰色缺口：背景 %dx%d 小于滑块 %dx%d，跳过灰洞检测",
                  bg.shape[1], bg.shape[0], tw, th)
        return None

    hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    b, g, r = cv2.split(bg)
    channel_spread = np.maximum.reduce([b, g, r]) - np.minimum.reduce([b, g, r])

    # 从严格到宽松。严格阈值可避免灰白瀑布、天空等背景区域误连成大块；宽松阈值
    # 用于兼容压缩较重或遮罩颜色略深的图片。
    thresholds = (
        (20, 150, 25),
        (25, 120, 30),
        (30, 100, 35),
        (40, 90, 45),
        (55, 75, 60),
    )

    best: tuple[float, int, int, int, int, int] | None = None
    for sat_max, val_min, spread_max in thresholds:
        mask = (
            (hsv[:, :, 1] <= sat_max)
            & (hsv[:, :, 2] >= val_min)
            & (channel_spread <= spread_max)
        ).astype(np.uint8)

        candidates = list(_component_candidates(mask, tw, th))
        if not candidates:
            continue

        current = max(candidates, key=lambda item: item[0])
        if best is None or current[0] > best[0]:
            best = current

        # 严格阈值下已经找到高度可信的近似满矩形，直接采用，避免继续放宽阈值后
        # 与背景浅色区域粘连导致坐标偏移。
        score, _x, _y, w, h, area = current
        fill_ratio = area / max(w * h, 1)
        if score >= 1.45 and fill_ratio >= 0.85:
            log.debug("灰色缺口：阈值(%d,%d,%d) 命中高可信块 "
                      "score=%.2f fill=%.2f x=%d wh=%dx%d",
                      sat_max, val_min, spread_max, score, fill_ratio,
                      current[1], w, h)
            return current[1]

    if best is None:
        log.debug("灰色缺口：所有阈值均无合格候选块，回退模板匹配")
        return None
    if best[0] < 1.0:
        log.debug("灰色缺口：最佳候选分数过低 score=%.2f x=%d，回退模板匹配",
                  best[0], best[1])
        return None
    log.debug("灰色缺口：采用最佳候选 score=%.2f x=%d", best[0], best[1])
    return best[1]


def _detect_gap_by_template(bg: np.ndarray, slider: np.ndarray) -> int:
    """旧版兜底：Canny 边缘 + 模板匹配。"""
    bg_edge = cv2.Canny(bg, 100, 200)
    tp_edge = cv2.Canny(slider, 100, 200)
    bg_rgb = cv2.cvtColor(bg_edge, cv2.COLOR_GRAY2BGR)
    tp_rgb = cv2.cvtColor(tp_edge, cv2.COLOR_GRAY2BGR)

    res = cv2.matchTemplate(bg_rgb, tp_rgb, cv2.TM_CCOEFF_NORMED)
    _, _, _, max_loc = cv2.minMaxLoc(res)
    return int(max_loc[0])


def detect_gap(big_bytes: bytes, small_bytes: bytes) -> int:
    """返回滑块需要移动的 x 像素（缺口左边界在背景图中的横坐标）。"""
    bg = _imdecode(big_bytes, cv2.IMREAD_COLOR)
    tp = _imdecode(small_bytes, cv2.IMREAD_UNCHANGED)
    if bg is None or tp is None:
        log.error("验证码图片解码失败 bigImage=%dB smallImage=%dB bg=%s tp=%s",
                  len(big_bytes), len(small_bytes),
                  bg is not None, tp is not None)
        raise ValueError("验证码图片解码失败")

    slider = _crop_slider(tp)
    size_hint = _estimate_box_size(slider)
    log.debug("缺口识别开始：背景=%dx%d 滑块裁剪后=%dx%d 尺寸估计=%s",
              bg.shape[1], bg.shape[0], slider.shape[1], slider.shape[0],
              size_hint)

    box = _detect_gap_by_box(bg, size_hint)
    if box is not None:
        x, border_z = box
        log.debug("缺口识别：矩形边框命中 x=%d z=%.2f", x, border_z)
        return x

    x = _detect_gap_by_gray_hole(bg, slider)
    if x is not None:
        log.debug("缺口识别：灰色缺口块命中 x=%d", x)
        return x

    x = _detect_gap_by_template(bg, slider)
    log.debug("缺口识别：回退模板匹配 x=%d", x)
    return x
