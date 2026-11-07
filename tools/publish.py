#!/usr/bin/env python3
"""一条命令发版：AMO 上传签名 → 拉回签名包 → 部署到 raysview → 自动更新生效。

前置：~/.hermes-hari/.secrets/amo.env 里填好 AMO_JWT_ISSUER / AMO_JWT_SECRET
用法：python3 tools/publish.py [--dry-run]
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
ARTIFACTS = os.path.join(ROOT, "artifacts")
SITE = os.path.join(ROOT, "site")
RAYSVIEW = os.path.expanduser("~/raysview")
PUBLIC = os.path.join(RAYSVIEW, "public/reading-collector")
SECRETS = os.path.expanduser("~/.hermes-hari/.secrets/amo.env")
BASE = "https://raysview.fun/reading-collector"


def read_secrets():
    if not os.path.exists(SECRETS):
        sys.exit(f"缺少 {SECRETS}")
    env = {}
    for line in open(SECRETS, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    if not env.get("AMO_JWT_ISSUER") or not env.get("AMO_JWT_SECRET"):
        sys.exit("amo.env 还没填 key/secret")
    return env["AMO_JWT_ISSUER"], env["AMO_JWT_SECRET"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    manifest = json.load(open(os.path.join(EXT, "manifest.json"), encoding="utf-8"))
    version = manifest["version"]
    addon_id = manifest["browser_specific_settings"]["gecko"]["id"]
    print(f"版本 {version}｜id {addon_id}")

    if args.dry_run:
        print("dry-run：不调 AMO、不写站点")
        return

    key, secret = read_secrets()
    os.makedirs(ARTIFACTS, exist_ok=True)
    cmd = [
        "npx", "--yes", "web-ext", "sign",
        "--channel=unlisted",
        f"--source-dir={EXT}",
        f"--artifacts-dir={ARTIFACTS}",
        f"--api-key={key}",
        f"--api-secret={secret}",
        "--no-input",
    ]
    print("→ 上传 AMO 并等待签名…（可能要 1–3 分钟）")
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        sys.exit("web-ext sign 失败，看上面输出")

    xpis = [os.path.join(ARTIFACTS, f) for f in os.listdir(ARTIFACTS) if f.endswith(".xpi")]
    if not xpis:
        sys.exit("没找到签名后的 .xpi")
    newest = max(xpis, key=os.path.getmtime)
    print("签名包：", newest)

    os.makedirs(PUBLIC, exist_ok=True)
    shutil.copyfile(newest, os.path.join(PUBLIC, "reading-collector.xpi"))

    updates = {
        "addons": {
            addon_id: {
                "updates": [{
                    "version": version,
                    "update_link": f"{BASE}/reading-collector.xpi",
                    "applications": {"gecko": {"strict_min_version": "140.0"}},
                }]
            }
        }
    }
    json.dump(updates, open(os.path.join(PUBLIC, "updates.json"), "w", encoding="utf-8"),
              indent=2, ensure_ascii=False)
    json.dump(updates, open(os.path.join(SITE, "updates.json"), "w", encoding="utf-8"),
              indent=2, ensure_ascii=False)

    subprocess.run(["git", "add", "public/reading-collector"], cwd=RAYSVIEW, check=True)
    subprocess.run(
        ["git", "-c", "user.name=Rayy Summers",
         "-c", "user.email=106456682+RayySummers@users.noreply.github.com",
         "commit", "-q", "-m", f"release(reading-collector): {version}"],
        cwd=RAYSVIEW, check=True,
    )
    subprocess.run(["git", "push", "-q", "origin", "main"], cwd=RAYSVIEW, check=True)
    print(f"\n✓ 已部署 {version}")
    print(f"   {BASE}/updates.json")
    print(f"   {BASE}/reading-collector.xpi")


if __name__ == "__main__":
    main()
