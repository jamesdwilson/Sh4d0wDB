#!/usr/bin/env python3
"""Detect degenerate repeated text in OpenClaw session transcripts.

Usage:
    python3 scripts/detect-dupe-text.py [session_dir]
    python3 scripts/detect-dupe-text.py --text "some text to check"

Scans .jsonl session files for assistant messages containing looping/repeated
substrings (e.g. the Mistral exec-error echo bug). Reports offending sessions
with the repeated pattern and character count.
"""
import json
import sys
import os
import glob

MIN_PATTERN_LEN = 30
MIN_REPEATS = 5
WINDOW_SIZE = 2000


def detect_repetition(text: str) -> tuple[str, int] | None:
    """Return (pattern, count) if text contains a degenerate repeating substring."""
    if len(text) < MIN_PATTERN_LEN * MIN_REPEATS:
        return None
    window = text[-WINDOW_SIZE:]
    for length in range(MIN_PATTERN_LEN, len(window) // MIN_REPEATS + 1):
        pattern = window[-length:]
        count = 0
        pos = len(window) - length
        while pos >= 0 and window[pos:pos + length] == pattern:
            count += 1
            pos -= length
        if count >= MIN_REPEATS:
            return (pattern, count)
    return None


def scan_text(text: str, label: str = "input"):
    """Check a single text string."""
    result = detect_repetition(text)
    if result:
        pattern, count = result
        preview = pattern[:80].replace('\n', '\\n')
        print(f"⚠️  REPETITION DETECTED in {label}")
        print(f"   Pattern ({len(pattern)} chars, {count}x): \"{preview}...\"")
        print(f"   Total text length: {len(text):,} chars")
        return True
    return False


def scan_session_file(filepath: str) -> bool:
    """Scan a .jsonl session transcript for degenerate repetition."""
    found = False
    try:
        with open(filepath) as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                msg = entry.get("message", {})
                if msg.get("role") != "assistant":
                    continue

                # Check text content blocks
                content = msg.get("content", [])
                if isinstance(content, str):
                    content = [{"type": "text", "text": content}]
                if not isinstance(content, list):
                    continue

                for block in content:
                    if not isinstance(block, dict):
                        continue
                    text = block.get("text", "")
                    if len(text) < MIN_PATTERN_LEN * MIN_REPEATS:
                        continue
                    result = detect_repetition(text)
                    if result:
                        pattern, count = result
                        preview = pattern[:80].replace('\n', '\\n')
                        fname = os.path.basename(filepath)
                        print(f"⚠️  {fname} line {line_num}")
                        print(f"   Pattern ({len(pattern)} chars, {count}x): \"{preview}...\"")
                        print(f"   Text length: {len(text):,} chars")
                        print(f"   Model: {msg.get('model', '?')} | Stop: {msg.get('stopReason', '?')}")
                        print()
                        found = True
    except Exception as e:
        print(f"Error reading {filepath}: {e}", file=sys.stderr)
    return found


def main():
    if "--text" in sys.argv:
        idx = sys.argv.index("--text")
        if idx + 1 < len(sys.argv):
            text = sys.argv[idx + 1]
            if not scan_text(text):
                print("✅ No repetition detected.")
            return

    session_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
        "~/.openclaw/agents/main/sessions"
    )

    if not os.path.isdir(session_dir):
        print(f"Directory not found: {session_dir}", file=sys.stderr)
        sys.exit(1)

    files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")),
                   key=os.path.getmtime, reverse=True)

    if not files:
        print(f"No .jsonl files found in {session_dir}")
        return

    print(f"Scanning {len(files)} session files in {session_dir}...\n")
    total_found = 0
    for filepath in files:
        if scan_session_file(filepath):
            total_found += 1

    if total_found:
        print(f"\n🔴 Found degenerate repetition in {total_found} session(s).")
    else:
        print("✅ No degenerate repetition found in any session.")


if __name__ == "__main__":
    main()
