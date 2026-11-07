#!/usr/bin/env python3
"""一条命令发版：版本号 +1 → 打 zip → 生成 updates.json 条目。

用法：
  python3 tools/release.py            # 只算，不写
  python3 tools/release.py --apply    # 真的改版本号并打 zip

产物：
  reading-collector-<新版本>.zip      （上传 AMO 用）
  site/updates.json                   （Firefox 自动更新清单）
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
MANIFEST = os.path.join(EXT, "manifest.json")
SITE = os.path.join(ROOT, "site")

FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "content.css",
    "popup.html",
    "popup.js",
    "icons",
]
BASE_URL = "https://raysview.fun/reading-collector"


def bump(v: str) -> str:
    parts = [int(x) for x in v.split(".")]
    parts[-1] += 1
    return ".".join(str(x) for x in parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    m = json.load(open(MANIFEST, encoding="utf-8"))
    old = m["version"]
    new = bump(old)
    addon_id = m["browser_specific_settings"]["gecko"]["id"]
    zip_name = f"reading-collector-{new}.zip"
    zip_path = os.path.join(ROOT, zip_name)

    print(f"版本 {old} → {new}")
    print(f"zip  {zip_name}")
    print(f"清单 {BASE_URL}/updates.json")

    if not args.apply:
        print("\n加 --apply 执行")
        return

    m["version"] = new
    m["browser_specific_settings"]["gecko"]["update_url"] = f"{BASE_URL}/updates.json"
    json.dump(m, open(MANIFEST, "w", encoding="utf-8"), indent=2, ensure_ascii=False)

    if os.path.exists(zip_path):
        os.remove(zip_path)
    subprocess.run(
        ["zip", "-q", "-r", zip_path] + FILES,
        cwd=EXT,
        check=True,
    )

    os.makedirs(SITE, exist_ok=True)
    updates = {
        "addons": {
            addon_id: {
                "updates": [
                    {
                        "version": new,
                        "update_link": f"{BASE_URL}/{zip_name.replace('.zip', '.xpi')}",
                        "applications": {"gecko": {"strict_min_version": "140.0"}},
                    }
                ]
            }
        }
    }
    json.dump(updates, open(os.path.join(SITE, "updates.json"), "w", encoding="utf-8"), indent=2, ensure_ascii=False)

    print(f"\n✓ 已写版本号 {new}，已打 {zip_name}")
    print("下一步：")
    print(f"  1. 上传 {zip_name} 到 AMO 签名")
    print(f"  2. 把签名后的 .xpi 放到 raysview 的 {BASE_URL}/")
    print(f"  3. 把 site/updates.json 部署到同一路径")
    print("  4. Firefox 下次启动自动更新")


if __name__ == "__main__":
    main()
