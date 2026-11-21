---
name: interactive-journal-redesign
description: 'Audit a running data-rich web app and redesign it as a high-end interactive journal spread or visual monograph. Use when asked for a live visual and information architecture (IA) audit, editorial data visualization, a narrative-over-dashboard redesign, or art direction inspired by Distill.pub, NYT Graphics, FT Visual Journalism, Works in Progress, or Tufte.'
argument-hint: 'Running app URL; optionally name the audience or request implementation'
---

# Interactive Journal Redesign

Turn a data-rich interface into an editorial argument supported by interactive figures. Borrow craft from the references, not their branding or layouts. Preserve the app's data semantics and core workflows.

Use the supplied URL or the active shared browser page. If neither is available, ask for the URL. Load `modern-web-guidance` before making frontend recommendations; use it for grid and typography, scroll navigation, disclosure, and below-the-fold rendering. If the skill is unavailable, note that and proceed with applicable web guidance.

## 1. Live Visual and IA Audit

Do not edit code. At **1440 x 900**, open every view or tab in the running app. Inspect the initial viewport, then scroll and exercise key controls and figure interactions. Capture representative baseline screenshots. Record what actually renders and distinguish observations from recommendations. Name any inaccessible views or states; do not substitute source inspection for live evidence.

- **Narrative and IA:** Identify what readers learn above the fold, what wastes that space, and whether the view order builds understanding. Flag duplicated headings or blurbs, misplaced controls, and provenance or methodology that interrupts the story.
- **Visual language:** Look for card chrome, weak hierarchy, overlong measures, poor contrast, and raw identifiers in reader-facing labels.
- **Figure-by-figure legibility:** Check axis baselines, domains, units, and scale transformations; label collisions and overplotting; legend footprint; and the ergonomics of the inspector or other detail view.

Deliver prioritized findings tied to specific views, figures, or screenshots.

## 2. Art Direction and Layout Plan

Still do not edit code. Translate the audit into a concrete spread plan:

- **Sequence:** Open with the mental model and key figures, move to core empirical findings and supporting detail, and close with methodology, provenance, and the colophon in an expandable disclosure. Keep source or estimate notes beside any figure that needs them to be interpreted correctly.
- **Grid and type:** Specify desktop columns, gutters, the figure span, the marginalia rail, and how each reflows on smaller screens. Keep prose around 60-65ch inside the wider chart grid. Pair an editorial serif, a quiet UI sans, and a tabular mono for data.
- **Paper and ink:** Define light and dark roles for paper, ink, muted text, hairlines, and data accents. Separate sections with whitespace and rules instead of grey cards. Check that text and graphic marks retain contrast in both themes.
- **Figure anatomy:** Give each plate a declarative, evidence-backed finding headline and enough context to interpret the figure. Use readable labels instead of raw hashes. Default to shared domains and units for comparisons across small multiples. Explicitly label estimates, non-linear scales, and non-zero baselines when relevant. Avoid turning uncertain or conditional findings into categorical claims.
- **Marginalia:** Specify a sticky desktop inspector with an in-flow mobile equivalent. Hover and keyboard focus preview the same detail. Click or Enter pins it; provide an obvious unpin action. Keep details reachable on touch and prevent sticky content from obscuring figures or focus targets.
- **Navigation and performance:** Plan scroll and section navigation, disclosure behavior, and how to defer costly below-the-fold work without hiding content from keyboard navigation or shifting the layout.

Share the audit and plan before the first edit. Stop after the plan unless the user has explicitly requested implementation. An audit-only or plan-only request never authorizes edits.

## 3. Implement and Verify When Authorized

Work in the existing app, keeping data calculations and core interactions intact. Run relevant project checks and verify the running result in the browser. Capture **light and dark** screenshots at **1440 x 900** and at a representative mobile width, including meaningful interaction states. Use the screenshots to check reading order, label overlap, clipping, contrast, and sticky rail or mobile inspector placement.

Exercise hover, keyboard focus, click and Enter pinning, unpinning, touch access, and the methodology disclosure. Compare transformed views with the baseline. Report the screenshots or their locations, which states were verified, and any gaps. Do not claim visual verification for states you could not open or exercise.