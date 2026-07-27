"""Command-line client for single and concurrent batch filing queries."""

import argparse
import csv
import sys

from api_models import MAX_CONCURRENCY
from log_config import setup_logging
from query_service import QueryService, unique_keywords


CSV_COLUMNS = [
    "查询词",
    "domain",
    "unitName",
    "nature",
    "mainLicence",
    "serviceLicence",
    "updateTime",
]


def parse_args():
    parser = argparse.ArgumentParser(description="工信部备案信息查询")
    parser.add_argument("keywords", nargs="*", help="域名、应用名或主办单位名称")
    parser.add_argument("-f", "--file", help="从文件读取查询词，每行一个")
    parser.add_argument(
        "-t",
        "--type",
        type=int,
        choices=(1, 6, 7, 8),
        default=1,
        help="服务类型：1 网站、6 APP、7 小程序、8 快应用",
    )
    parser.add_argument(
        "-c",
        "--concurrency",
        type=int,
        choices=range(1, MAX_CONCURRENCY + 1),
        default=3,
        metavar="1-10",
        help="批量查询并发数（默认 3）",
    )
    parser.add_argument("-o", "--out", help="将结果保存为 CSV")
    return parser.parse_args()


def load_keywords(args) -> list[str]:
    keywords = list(args.keywords)
    if args.file:
        with open(args.file, encoding="utf-8") as source:
            keywords.extend(line.strip() for line in source)
    return unique_keywords(keywords)


def result_rows(results: list[dict]) -> list[dict]:
    rows: list[dict] = []
    total = len(results)
    for index, result in enumerate(results, 1):
        keyword = result["keyword"]
        if not result["success"]:
            print(f"[{index}/{total}] ERR {keyword}  {result['error']}")
            rows.append({"查询词": keyword, "unitName": f"错误: {result['error']}"})
        elif not result["found"]:
            print(f"[{index}/{total}] -- {keyword}  未备案")
            rows.append({"查询词": keyword, "unitName": "未备案"})
        else:
            for record in result["records"]:
                licence = record["serviceLicence"] or record["mainLicence"]
                print(
                    f"[{index}/{total}] OK {keyword}  {record['unitName']}  "
                    f"{licence}  {record['domain']}"
                )
                rows.append({"查询词": keyword, **record})
    return rows


def write_csv(path: str, rows: list[dict]):
    with open(path, "w", newline="", encoding="utf-8-sig") as target:
        writer = csv.DictWriter(target, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    print(f"\n已保存 {len(rows)} 行到 {path}")


def main():
    setup_logging()
    args = parse_args()
    keywords = load_keywords(args)
    if not keywords:
        print("请至少提供一个查询词。", file=sys.stderr)
        return 1

    response = QueryService().query_batch(
        keywords,
        service_type=args.type,
        concurrency=args.concurrency,
    )
    rows = result_rows(response["results"])
    print(
        f"\n完成：成功 {response['succeeded']}，失败 {response['failed']}，"
        f"耗时 {response['elapsed_ms']} ms"
    )
    if args.out:
        write_csv(args.out, rows)
    return 0 if response["failed"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
