# -*- coding: utf-8 -*-
# Builds the Task 3 index.html in the scratch app from the repo's index.html:
# the new sidebar, five sections, and the old sections' content moved into
# the Settings tabs (whole blocks, by line number of the 0.16 file).
import io, sys

SRC = "E:/claude/RudariFlow/index.html"
OUT = sys.argv[1]
src = io.open(SRC, encoding="utf-8").read().split("\n")


def L(a, b):
    """Lines a..b (1-based, inclusive) of the 0.16 index.html."""
    return "\n".join(src[a - 1 : b])


# Anchors: fail loudly if the file is not the one this was written for.
assert 'id="section-general"' in src[106]
assert 'id="section-engine"' in src[157]
assert 'id="section-recording"' in src[280]
assert 'id="section-dictionary"' in src[383]
assert 'id="section-replacements"' in src[451]
assert 'id="section-ai"' in src[461]
assert 'id="section-history"' in src[568]
assert 'id="section-files"' in src[596]
assert "</main>" in src[769]

HEAD = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RudariFlow</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <div id="app">
      <div id="titlebar" data-tauri-drag-region></div>
      <div id="app-body">
      <aside id="sidebar">
        <div class="sidebar-header">
          <img class="app-logo" src="/src/sidebar-logo.png" alt="RudariFlow" />
          <div id="status-indicator" class="status-pill" role="status" aria-live="polite" data-tone="busy">
            <span id="status-dot" class="status-dot" aria-hidden="true"></span>
            <span id="status-text" data-i18n="status_loading">Loading models…</span>
            <span id="status-marker" class="status-marker hidden" role="img"></span>
          </div>
        </div>
        <nav id="sidebar-nav" data-i18n-aria-label="nav_label" aria-label="Sections">
          <button type="button" class="nav-item" data-section="home" aria-current="page">
            <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 7.5L8 3l5.5 4.5V13a.5.5 0 01-.5.5H9.8v-3.6H6.2v3.6H3a.5.5 0 01-.5-.5V7.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
            </svg>
            <span data-i18n="nav_home">Home</span>
          </button>
          <button type="button" class="nav-item" data-section="files">
            <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 2h5.5L12.5 5v8.5a.5.5 0 01-.5.5H4a.5.5 0 01-.5-.5v-11A.5.5 0 014 2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M9.5 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M6 8.5v3M8 7.5v5M10 9v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            <span data-i18n="nav_files">Files</span>
          </button>
          <button type="button" class="nav-item" data-section="meetings">
            <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="5.5" cy="5.5" r="2" stroke="currentColor" stroke-width="1.2"/>
              <circle cx="10.5" cy="5.5" r="2" stroke="currentColor" stroke-width="1.2"/>
              <path d="M2 12.5c0-1.9 1.6-3.5 3.5-3.5S9 10.6 9 12.5M8.6 9.4A3.5 3.5 0 0114 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            <span data-i18n="nav_meetings">Meetings</span>
          </button>
          <button type="button" class="nav-item" data-section="soundboard">
            <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M10.5 6a2.8 2.8 0 010 4M12.3 4.3a5.2 5.2 0 010 7.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            <span data-i18n="nav_soundboard">Soundboard</span>
          </button>
          <button type="button" class="nav-item nav-settings" data-section="settings">
            <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 5h5M11.5 5h2M2.5 11h2M8.5 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
              <circle cx="9.5" cy="5" r="1.8" stroke="currentColor" stroke-width="1.2"/>
              <circle cx="6.5" cy="11" r="1.8" stroke="currentColor" stroke-width="1.2"/>
            </svg>
            <span data-i18n="nav_settings">Settings</span>
          </button>
        </nav>
        <div class="sidebar-footer">
          <span class="version-text" id="version-text"></span>
          <a href="#" id="credit-link" class="credit-text">by oggi</a>
        </div>
      </aside>

      <main id="content">
        <section id="section-home" class="content-section active">
          <div class="section-header">
            <h2 class="section-title" id="home-title" data-i18n="home_title_loading">Getting ready…</h2>
          </div>
"""

# Home, for now: the list of the old History section (its toolbar and its
# "Keep history" row go to Settings > General).
HOME = (
    L(593, 594)
    + """
        </section>

"""
)

FILES_ON = L(597, 769)  # Files, Meetings, Soundboard, </main>

SETTINGS_OPEN = """        <section id="section-settings" class="content-section">
          <div class="section-header">
            <h2 class="section-title" data-i18n="settings_title">Settings</h2>
          </div>
          <div id="settings-tabs" class="tabs" role="tablist" data-i18n-aria-label="settings_title" aria-label="Settings">
            <button type="button" role="tab" class="tab" id="tab-dictation" data-tab="dictation" aria-controls="panel-dictation" aria-selected="true" data-i18n="tab_dictation">Dictation</button>
            <button type="button" role="tab" class="tab" id="tab-ai" data-tab="ai" aria-controls="panel-ai" aria-selected="false" tabindex="-1" data-i18n="tab_ai">AI cleanup</button>
            <button type="button" role="tab" class="tab" id="tab-dictionary" data-tab="dictionary" aria-controls="panel-dictionary" aria-selected="false" tabindex="-1" data-i18n="tab_dictionary">Dictionary</button>
            <button type="button" role="tab" class="tab" id="tab-models" data-tab="models" aria-controls="panel-models" aria-selected="false" tabindex="-1" data-i18n="tab_models">Models &amp; GPU</button>
            <button type="button" role="tab" class="tab" id="tab-general" data-tab="general" aria-controls="panel-general" aria-selected="false" tabindex="-1" data-i18n="tab_general">General</button>
          </div>
"""


def panel(name, body, hidden=True):
    return (
        '          <div id="panel-%s" class="tab-panel" role="tabpanel" aria-labelledby="tab-%s"%s>\n' % (name, name, " hidden" if hidden else "")
        + body.rstrip("\n")
        + "\n          </div>\n"
    )


DICTATION = L(286, 381)  # the Recording section's rows
AI = (
    '          <p class="section-desc panel-lead" data-i18n="ai_desc">' + src[464].split(">", 1)[1].rsplit("</p>", 1)[0] + "</p>\n" + L(467, 566)
)
DICTIONARY = (
    "          " + src[386].strip().replace('class="section-desc"', 'class="section-desc panel-lead"') + "\n"
    + L(389, 449)
    + '\n          <h3 class="subsection-title" data-i18n="replacements_title">Replacements</h3>\n'
    + "          " + src[454].strip().replace('class="section-desc"', 'class="subsection-desc"') + "\n"
    + L(457, 459)
)
MODELS = L(163, 278)  # the Engine section's rows and "Unused models"
GENERAL = (
    L(112, 154)  # the General section's rows, without the list's closing tag
    + "\n"
    + L(575, 587)  # "Keep history"
    + "\n          </div>\n"
    + L(589, 592)  # the count and "Clear history"
)

TAIL = (
    """        </section>
      </main>
"""
    + "\n".join(src[770:])
)

assert src[592].strip().startswith('<p id="history-empty"'), src[592]
assert src[593].strip().startswith('<div id="history-list"'), src[593]
assert src[111].strip() == '<div class="settings-list">' and src[154].strip() == "</div>", (src[111], src[154])
assert src[574].strip().startswith('<div class="setting-row">') and src[586].strip() == "</div>", (src[574], src[586])
assert src[588].strip().startswith('<div class="history-toolbar">'), src[588]
assert src[768].strip() == "</section>" and src[769].strip() == "</main>"

files_on = "\n".join(src[596:769])  # Files, Meetings, Soundboard sections
html = (
    HEAD
    + HOME
    + files_on
    + "\n"
    + SETTINGS_OPEN
    + panel("dictation", DICTATION, hidden=False)
    + panel("ai", AI)
    + panel("dictionary", DICTIONARY)
    + panel("models", MODELS)
    + panel("general", GENERAL)
    + TAIL
)
io.open(OUT, "w", encoding="utf-8", newline="\n").write(html)
print("written", OUT, len(html.split("\n")), "lines")
