# -*- coding: utf-8 -*-
# Removes from the page stylesheet the rules the shared components and
# settings.css replace. In the plan: the first group belongs to Task 2,
# the second to Task 6, the third to Task 7.
import io, sys

APP = sys.argv[1]
p = APP + "/src/style.css"
s = io.open(p, encoding="utf-8").read()


def cut(start, end, new=""):
    global s
    assert s.count(start) == 1, (start[:50], s.count(start))
    a = s.index(start)
    b = s.index(end, a) + len(end)
    s = s[:a] + new + s[b:]


def cut_before(start, before, new=""):
    """Remove from `start` up to (not including) `before`."""
    global s
    assert s.count(start) == 1 and s.count(before) == 1, (start[:50], s.count(start), before[:50], s.count(before))
    a = s.index(start)
    b = s.index(before, a)
    s = s[:a] + new + s[b:]


# Task 2: shared rules that sat in page sections (components.css has them now).
cut(".subsection-title {\n", "  max-width: 560px;\n}\n\n")
cut(".link-btn {\n", "  text-underline-offset: 2px;\n}\n\n")
cut(".progress-track {\n", "  transition: width 0.3s ease;\n}\n\n")
cut(".field-textarea {\n", ".field-textarea:focus {\n  border-color: var(--accent);\n  box-shadow: 0 0 0 2px var(--accent-subtle);\n}\n\n")

# Task 6: Settings rows that settings.css lays out now.
cut_before("/* ── Model Row ─", "/* ── Unused models")
cut(".ai-model-row {\n", "}\n\n")
cut(".download-progress {\n", "  gap: 6px;\n}\n\n")
cut(".pc-check-result {\n", "  padding: 0 0 12px;\n}\n")
cut_before("/* ── History: the count", "/* ── Files ─")

# Task 7: the old list rows.
cut_before("/* ── Unused models", "/* ── Replacements ─")
cut_before("/* ── Replacements ─", "/* ── Files ─")
cut_before(".rule-list {\n", ".pc-check-result pre {\n")
cut_before(".rule-language {\n", ".ai-test {\n")
cut_before("/* ── Dictionary ─", ".ai-output-warn {\n", "/* ── Write in: its warnings ── */\n\n")

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok", len(s.split("\n")), "lines")
