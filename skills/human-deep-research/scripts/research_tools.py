#!/usr/bin/env python3
"""
Research Tools for human-deep-research skill.
Provides zero-configuration live web search (via DuckDuckGo) and clean web page extraction.
"""

import argparse
import json
import re
import sys
import urllib.parse
from typing import List, Dict

try:
    from ddgs import DDGS
except ImportError:
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        print("Error: ddgs package not installed. Run: pip install ddgs", file=sys.stderr)
        sys.exit(1)

import httpx
from bs4 import BeautifulSoup


def search_web(query: str, max_results: int = 8) -> List[Dict[str, str]]:
    """Perform live web search via DuckDuckGo."""
    try:
        ddgs = DDGS()
        results = list(ddgs.text(query, max_results=max_results))
        formatted = []
        for r in results:
            formatted.append({
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", ""),
            })
        return formatted
    except Exception as e:
        print(f"Search warning/error: {e}", file=sys.stderr)
        return []


def fetch_url(url: str, max_chars: int = 12000) -> Dict[str, str]:
    """Fetch URL and convert HTML to clean readable text."""
    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        with httpx.Client(follow_redirects=True, timeout=15.0) as client:
            resp = client.get(url, headers=headers)
            resp.raise_for_status()

            soup = BeautifulSoup(resp.text, "html.parser")
            # Remove scripts, styles, forms, navs
            for tag in soup(["script", "style", "nav", "footer", "header", "aside", "svg", "noscript"]):
                tag.decompose()

            # Extract main content
            main = soup.find("article") or soup.find("main") or soup.body or soup
            text = main.get_text(separator="\n", strip=True)
            # Collapse multiple newlines
            clean_text = re.sub(r"\n{3,}", "\n\n", text)
            if len(clean_text) > max_chars:
                clean_text = clean_text[:max_chars] + f"\n\n[... Truncated at {max_chars} chars ...]"

            title = soup.title.string.strip() if soup.title and soup.title.string else url
            return {
                "url": str(resp.url),
                "title": title,
                "status": resp.status_code,
                "content": clean_text,
            }
    except Exception as e:
        return {
            "url": url,
            "title": "",
            "status": 500,
            "error": str(e),
            "content": f"Failed to fetch {url}: {e}",
        }


def main():
    parser = argparse.ArgumentParser(description="Human Deep Research Helper Tools")
    subparsers = parser.add_subparsers(dest="subcommand")

    # Search subcommand
    search_parser = subparsers.add_parser("search", help="Execute live web search")
    search_parser.add_argument("--query", "-q", required=True, help="Search query")
    search_parser.add_argument("--count", "-c", type=int, default=8, help="Max results count")
    search_parser.add_argument("--json", action="store_true", help="Output as JSON")

    # Fetch subcommand
    fetch_parser = subparsers.add_parser("fetch", help="Fetch and parse clean webpage text")
    fetch_parser.add_argument("--url", "-u", required=True, help="URL to fetch")
    fetch_parser.add_argument("--max-chars", type=int, default=12000, help="Max chars to retain")
    fetch_parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.subcommand == "search":
        results = search_web(args.query, args.count)
        if args.json:
            print(json.dumps(results, indent=2))
        else:
            print(f"\n=== Search Results for: '{args.query}' ({len(results)} found) ===\n")
            for i, r in enumerate(results, 1):
                print(f"[{i}] {r['title']}")
                print(f"    URL: {r['url']}")
                print(f"    Snippet: {r['snippet']}\n")

    elif args.subcommand == "fetch":
        res = fetch_url(args.url, args.max_chars)
        if args.json:
            print(json.dumps(res, indent=2))
        else:
            print(f"=== [{res.get('status')}] {res.get('title')} ===")
            print(f"URL: {res.get('url')}\n")
            print(res.get("content", ""))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
