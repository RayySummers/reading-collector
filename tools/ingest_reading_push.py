#!/usr/bin/env python3
"""读取 Firefox 扩展推送出来的 reading-push-*.json，按类别分流。

用法：
  python3 ingest_reading_push.py            # 只看
  python3 ingest_reading_push.py --apply    # 写盘 + 把已处理的 json 挪进 processed/

分流：
  vocab → ~/.hermes-hari/workspace/english-reading/queue.tsv  (Word / Sentence / Source / ts)
  idea  → vault/clippings/ideas/<YYYY-MM>.md
  fact  → vault/clippings/facts/<YYYY-MM>.md
文件来源默认：D:\\Downloads\\Firefox（Firefox 的下载目录）
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import shutil

VAULT = "/mnt/d/Obsidian/rays-vault"
SRC_DIR = "/mnt/d/Downloads/Firefox"
PROCESSED = os.path.join(SRC_DIR, "reading-push-processed")
QUEUE_DIR = os.path.expanduser("~/.hermes-hari/workspace/english-reading")
QUEUE = os.path.join(QUEUE_DIR, "queue.tsv")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(SRC_DIR, "reading-push-*.json")))
    if not files:
        print("没找到 reading-push-*.json（先在网页上点『推送』）")
        return

    vocab, ideas, facts = [], [], []
    for path in files:
        try:
            d = json.load(open(path, encoding="utf-8"))
        except Exception as e:
            print("跳过坏文件", path, e)
            continue
        title = d.get("title") or ""
        url = d.get("url") or ""
        for it in d.get("items", []):
            row = {
                "text": (it.get("text") or "").strip(),
                "context": (it.get("context") or "").strip(),
                "note": (it.get("note") or "").strip(),
                "ts": it.get("ts") or d.get("pushedAt") or "",
                "title": title,
                "url": url,
            }
            if not row["text"]:
                continue
            {"vocab": vocab, "idea": ideas, "fact": facts}.get(it.get("kind"), facts).append(row)

    print(f"文件 {len(files)} 个 → vocab {len(vocab)}｜idea {len(ideas)}｜fact {len(facts)}")
    if not args.apply:
        for r in (vocab + ideas + facts)[:8]:
            print("  ·", r["text"][:50], "←", r["title"][:40])
        print("\n加 --apply 才写盘")
        return

    def clean(t):
        t = (t or "").strip()
        if "\n" in t:
            lines = [x.strip() for x in t.split("\n") if x.strip()]
            if lines:
                t = lines[-1]
        return re.sub(r"\s+", " ", t).strip()

    month = dt.datetime.now().strftime("%Y-%m")

    if vocab:
        os.makedirs(QUEUE_DIR, exist_ok=True)
        new = not os.path.exists(QUEUE)
        with open(QUEUE, "a", encoding="utf-8") as f:
            if new:
                f.write("Word\tSentence\tSource\tts\n")
            for r in vocab:
                sent = clean(r["context"] or r["text"])
                f.write(f"{r['text']}\t{sent}\t{r['title']}\t{r['ts']}\n")

    for rows, sub, header, tags in [
        (ideas, "clippings/ideas", f"阅读想法 {month}", "reading, ideas"),
        (facts, "clippings/facts", f"事实与引用 {month}", "reading, facts"),
    ]:
        if not rows:
            continue
        p = os.path.join(VAULT, sub, f"{month}.md")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        new = not os.path.exists(p)
        with open(p, "a", encoding="utf-8") as f:
            if new:
                f.write(f"---\ntitle: {header}\ntags: [{tags}]\n---\n\n")
            for r in rows:
                f.write(f"## {clean(r['text'])[:40]}\n\n")
                if r["note"]:
                    f.write(f"> {r['note']}\n\n")
                f.write(f"- 原文：{clean(r['context'] or r['text'])}\n")
                f.write(f"- 来源：[{r['title'] or '链接'}]({r['url']})\n\n")

    os.makedirs(PROCESSED, exist_ok=True)
    for path in files:
        shutil.move(path, os.path.join(PROCESSED, os.path.basename(path)))
    print("已写盘，推送文件已归档到", PROCESSED)


if __name__ == "__main__":
    main()
