// Shared card renderer for the three prototype directions (D-01, D-02).
//
// Plain browser script: no modules, no build, no network. Open any page
// straight off the filesystem and it works.
//
// One renderer for all three directions is a deliberate reading of D-01's
// "standalone pages". Each page is still openable with no build; sharing the
// renderer is what keeps the three honest about varying ONLY layout and
// density. A per-page renderer would let card anatomy drift and the review
// would end up comparing two axes at once.
//
// Every node is built with createElement + textContent. No markup is ever
// assembled as a string and assigned to an element.
//
// The prototypes are throwaway, but the pattern they demonstrate is not:
// packages/plugin's lint fails outright on every HTML-injection sink (plan
// 03-01), and a prototype that built its cards by string concatenation would
// be teaching the exact habit the plugin forbids -- on data (headlines, issue
// titles, mail subjects) that is untrusted in production. This file is also
// grep-asserted to contain no sink identifier at all, which is why the rule
// is described above rather than named.

(function () {
  "use strict";

  var STATE_TO_PRESENTATION = {
    live: "ready",
    stale: "stale",
    empty: "empty",
    "permission-required": "permission-required",
    failure: "error",
  };

  /** Never Date.now(): relative time is measured from the fixture's own fixed
   *  `now`, so "2 min ago" means the same thing in every run and in every
   *  screenshot baseline plan 03-09 takes from this same data. */
  function relativeTime(observedAt, now) {
    var deltaMs = new Date(observedAt).getTime() - new Date(now).getTime();
    var formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    var units = [
      ["day", 86400000],
      ["hour", 3600000],
      ["minute", 60000],
      ["second", 1000],
    ];
    for (var i = 0; i < units.length; i++) {
      var amount = deltaMs / units[i][1];
      if (Math.abs(amount) >= 1 || units[i][0] === "second") {
        return formatter.format(Math.round(amount), units[i][0]);
      }
    }
    return formatter.format(0, "second");
  }

  function absoluteTime(observedAt) {
    var date = new Date(observedAt);
    return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fill(template, replacements) {
    var out = template;
    Object.keys(replacements).forEach(function (key) {
      out = out.split("{" + key + "}").join(replacements[key]);
    });
    return out;
  }

  /** The widget's own title, lowercased where it appears mid-sentence
   *  (03-UI-SPEC.md ## Copywriting Contract). A proper noun keeps its
   *  capitals, so only the first character is lowered. */
  function midSentence(title) {
    return title.charAt(0).toLowerCase() + title.slice(1);
  }

  // --- Body renderers, one per fixture `bodyKind` ------------------------

  function appendKpi(body, data) {
    if (!data.kpi) return;
    body.appendChild(el("p", "ccc-kpi", data.kpi));
    if (data.kpiLabel) body.appendChild(el("p", "ccc-kpi-label", data.kpiLabel));
  }

  function renderStatus(body, data) {
    appendKpi(body, data);
    if (data.headline) body.appendChild(el("p", "ccc-line ccc-row-primary", data.headline));
    (data.lines || []).forEach(function (line) {
      body.appendChild(el("p", "ccc-line-muted", line));
    });
  }

  function renderAgenda(body, data) {
    appendKpi(body, data);
    if (data.nextEvent) {
      var next = el("p", "ccc-line");
      next.appendChild(el("span", "ccc-row-primary", data.nextEvent.time + "  "));
      next.appendChild(el("span", null, data.nextEvent.title));
      body.appendChild(next);
    }
    if ((data.dueTasks || []).length > 0) {
      var list = el("ul", "ccc-rows");
      data.dueTasks.forEach(function (task) {
        var row = el("li", "ccc-row");
        row.appendChild(el("span", "ccc-row-primary", task.title));
        row.appendChild(el("span", "ccc-row-meta", task.due));
        list.appendChild(row);
      });
      body.appendChild(list);
    }
    if (data.unread) body.appendChild(el("p", "ccc-line-muted", data.unread.summary));
  }

  function renderTable(body, data, fields) {
    appendKpi(body, data);
    var list = el("ul", "ccc-rows");
    (data.rows || []).forEach(function (entry) {
      var row = el("li", "ccc-row");
      row.appendChild(el("span", "ccc-row-primary", entry[fields[0]]));
      fields.slice(1).forEach(function (field) {
        if (entry[field]) row.appendChild(el("span", "ccc-row-meta", entry[field]));
      });
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  function renderUsage(body, data) {
    appendKpi(body, data);
    (data.bars || []).forEach(function (bar) {
      var wrap = el("div", "ccc-bar");
      var label = el("p", "ccc-line-muted", bar.label + " — " + bar.valueText);
      var track = el("div", "ccc-bar-track");
      var fillNode = el("div", "ccc-bar-fill");
      // A bar's length is DATA, not design -- the one value a static token
      // cannot carry. It reaches CSS the way the plugin's will: as a --ccc-*
      // custom property consumed by a class, never as a style assignment
      // (which packages/plugin's lint rejects outright, plan 03-01).
      fillNode.style.setProperty("--ccc-bar-pct", bar.pct + "%");
      track.appendChild(fillNode);
      wrap.appendChild(label);
      wrap.appendChild(track);
      body.appendChild(wrap);
    });
    if (data.tokens) {
      body.appendChild(
        el(
          "p",
          "ccc-line-muted",
          data.tokens.input + " · " + data.tokens.output + " · " + data.tokens.cache,
        ),
      );
    }
    if (data.capacityNote) body.appendChild(el("p", "ccc-line-muted", data.capacityNote));
    if (data.estimate) {
      var estimate = el("p", "ccc-line");
      estimate.appendChild(el("span", "ccc-row-primary", data.estimate.value + "  "));
      estimate.appendChild(el("span", "ccc-row-meta", data.estimate.label));
      body.appendChild(estimate);
    }
  }

  function renderStories(body, data) {
    appendKpi(body, data);
    if (data.marketLine) body.appendChild(el("p", "ccc-line-muted", data.marketLine));
    var list = el("ul", "ccc-rows");
    (data.rows || []).forEach(function (story) {
      var row = el("li", "ccc-row");
      var head = el("div");
      head.appendChild(el("p", "ccc-kpi-label", story.category));
      head.appendChild(el("p", "ccc-line ccc-row-primary", story.headline));
      head.appendChild(el("p", "ccc-prose", story.summary));
      head.appendChild(el("p", "ccc-row-meta", story.sourceCount + " · " + story.age));
      row.appendChild(head);
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  function renderActions(body, data) {
    var list = el("ul", "ccc-actions");
    (data.actions || []).forEach(function (label) {
      var item = el("li");
      item.appendChild(el("button", "ccc-action", label));
      list.appendChild(item);
    });
    body.appendChild(list);
  }

  var BODY_RENDERERS = {
    status: renderStatus,
    agenda: renderAgenda,
    sessions: function (body, data) {
      renderTable(body, data, ["name", "project", "model", "elapsed", "status"]);
    },
    shortcuts: function (body, data) {
      renderTable(body, data, ["project", "branch", "dirty", "openIssues", "sessions"]);
    },
    usage: renderUsage,
    stories: renderStories,
    repos: function (body, data) {
      renderTable(body, data, ["name", "stars", "growth", "note"]);
    },
    actions: renderActions,
  };

  // --- Card frame -------------------------------------------------------

  function renderStateBody(body, panel, variant, presentation, copy) {
    var names = { Panel: panel.title, panel: midSentence(panel.title) };
    var sourceNames = { Source: panel.sourceLabel, source: midSentence(panel.sourceLabel) };

    if (presentation === "empty") {
      body.appendChild(el("p", "ccc-state-heading", copy.emptyHeading));
      body.appendChild(el("p", "ccc-prose", fill(copy.emptyBody, names)));
      return;
    }

    if (presentation === "permission-required") {
      body.appendChild(el("p", "ccc-state-heading", fill(copy.permissionHeading, sourceNames)));
      body.appendChild(
        el(
          "p",
          "ccc-prose",
          fill(copy.permissionBody, {
            source: sourceNames.source,
            panel: names.panel,
          }),
        ),
      );
      body.appendChild(
        el("button", "ccc-connect-button", fill(copy.permissionAction, sourceNames)),
      );
      return;
    }

    if (presentation === "error") {
      var heading = el("p", "ccc-state-heading");
      heading.appendChild(el("span", "ccc-state-glyph", "✕"));
      heading.appendChild(el("span", null, fill(copy.errorHeading, names)));
      body.appendChild(heading);
      body.appendChild(el("p", "ccc-prose", copy.errorBody));
      if (variant.message) body.appendChild(el("p", "ccc-line-muted", variant.message));
      return;
    }

    var renderer = BODY_RENDERERS[panel.bodyKind];
    if (renderer) renderer(body, variant.data || {});
  }

  function renderFooter(card, panel, variant, fixtures) {
    var copy = fixtures.copy;
    var footer = el("div", "ccc-card-footer");

    // 1. Relative "last updated", with the absolute timestamp reachable by
    //    BOTH hover and focus. `title` alone is not keyboard-reachable and
    //    fails A11Y-01, so a visually hidden node carries it too.
    var absolute = absoluteTime(variant.observedAt);
    var time = document.createElement("time");
    time.setAttribute("datetime", variant.observedAt);
    time.setAttribute("title", absolute);
    time.setAttribute("tabindex", "0");
    time.textContent = relativeTime(variant.observedAt, fixtures.now);
    footer.appendChild(time);
    footer.appendChild(el("span", "ccc-visually-hidden", "Last updated " + absolute));

    // 2. Freshness badge: text label AND a distinct glyph (A11Y-04).
    var freshnessBadge = el("span", "ccc-badge");
    freshnessBadge.setAttribute("data-freshness", variant.freshness);
    freshnessBadge.appendChild(
      el("span", null, fixtures.freshnessGlyphs[variant.freshness] || "●"),
    );
    freshnessBadge.appendChild(el("span", null, copy.freshnessLabels[variant.freshness]));
    freshnessBadge.setAttribute("aria-label", "Freshness: " + variant.freshness);
    footer.appendChild(freshnessBadge);

    // 3. Partial badge: its own element beside the freshness badge, never
    //    folded into it (ADR-0002 -- two independent signals).
    if (variant.partiality && variant.partiality.partial) {
      var missing = (variant.partiality.missingSources || []).join(", ");
      var partialBadge = el("span", "ccc-badge");
      partialBadge.appendChild(el("span", null, fixtures.partialGlyph));
      partialBadge.appendChild(el("span", null, copy.partialLabel));
      partialBadge.setAttribute(
        "aria-label",
        "Partial — " +
          (variant.partiality.missingSources || []).length +
          " source(s) didn't respond: " +
          missing,
      );
      footer.appendChild(partialBadge);
    }

    // 4. Source disclosure: a real button, never a tooltip (A11Y-01, D-16).
    var panelId = "sources-" + panel.id + "-" + Math.random().toString(36).slice(2, 8);
    var sourceList = el("ul", "ccc-source-panel");
    sourceList.id = panelId;
    sourceList.hidden = true;
    (variant.sources || []).forEach(function (source) {
      sourceList.appendChild(el("li", null, source.label + " — " + source.status));
    });

    var button = el("button", "ccc-source-button", copy.sourceButton);
    button.type = "button";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", panelId);
    button.addEventListener("click", function () {
      var open = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", open ? "false" : "true");
      sourceList.hidden = open;
    });
    sourceList.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        button.setAttribute("aria-expanded", "false");
        sourceList.hidden = true;
        button.focus();
      }
    });
    footer.appendChild(button);
    footer.appendChild(sourceList);

    card.appendChild(footer);
  }

  function renderCard(panel, stateName, fixtures) {
    var variant = panel.states[stateName];
    var presentation = STATE_TO_PRESENTATION[stateName];

    var card = el("article", "ccc-card");
    card.setAttribute("data-presentation", presentation);
    card.setAttribute("data-size", panel.sizeHint);
    card.setAttribute("data-panel", panel.id);

    card.appendChild(el("h3", "ccc-card-title", panel.title));

    var body = el("div", "ccc-card-body");
    renderStateBody(body, panel, variant, presentation, fixtures.copy);
    card.appendChild(body);

    renderFooter(card, panel, variant, fixtures);
    return card;
  }

  // --- Public surface ---------------------------------------------------

  function clear(container) {
    while (container.firstChild) container.removeChild(container.firstChild);
  }

  /** Renders every PRD 7.1 panel, in the fixture array's order. The fixture
   *  array is the SINGLE ordering source -- no page re-sorts it, so all three
   *  directions show the same panels in the same order (UI-01 ordering). */
  function renderOverview(container, stateName) {
    var fixtures = globalThis.CCC_FIXTURES;
    clear(container);
    fixtures.panels.forEach(function (panel) {
      container.appendChild(renderCard(panel, stateName, fixtures));
    });
  }

  /** One representative destination screen (D-03), rendered as a single wide
   *  card so it inherits the same frame, footer and state copy as the
   *  Overview cards rather than growing a second card anatomy. */
  function renderScreen(container, screenId, stateName) {
    var fixtures = globalThis.CCC_FIXTURES;
    var screen = fixtures.screens[screenId];
    var presentation = STATE_TO_PRESENTATION[stateName];
    clear(container);

    var card = el("article", "ccc-card");
    card.setAttribute("data-presentation", presentation);
    card.setAttribute("data-size", "wide");
    card.setAttribute("data-screen", screenId);
    card.appendChild(el("h3", "ccc-card-title", screen.title));

    var body = el("div", "ccc-card-body");
    var pseudoPanel = {
      id: screen.id,
      title: screen.title,
      sourceLabel: screen.sourceLabel,
      bodyKind: "screen",
    };

    if (presentation === "ready" || presentation === "stale") {
      var list = el("ul", "ccc-rows");
      screen.rows.forEach(function (cells) {
        var row = el("li", "ccc-row");
        cells.forEach(function (cell, index) {
          row.appendChild(el("span", index === 0 ? "ccc-row-primary" : "ccc-row-meta", cell));
        });
        list.appendChild(row);
      });
      body.appendChild(el("p", "ccc-kpi-label", screen.columns.join(" · ")));
      body.appendChild(list);
    } else {
      renderStateBody(body, pseudoPanel, { message: null }, presentation, fixtures.copy);
    }
    card.appendChild(body);

    // The screen reuses the Overview's service-health timing so every card on
    // the page tells the same story when the switcher flips.
    var timingPanel = fixtures.panels[0];
    renderFooter(card, pseudoPanel, timingPanel.states[stateName], fixtures);
    container.appendChild(card);
  }

  /** D-04: ONE control flips every card at once. The handler writes the
   *  chosen state to the root element (so CSS can react) and re-renders in a
   *  single pass -- five copies of a page would make the directions
   *  incomparable, which is the whole point of the round. */
  function installStateSwitcher(selectEl, rerender) {
    function apply() {
      document.documentElement.dataset.state = selectEl.value;
      rerender(selectEl.value);
    }
    selectEl.addEventListener("change", apply);
    apply();
  }

  globalThis.CCC_PROTO = {
    renderOverview: renderOverview,
    renderScreen: renderScreen,
    installStateSwitcher: installStateSwitcher,
  };
})();
