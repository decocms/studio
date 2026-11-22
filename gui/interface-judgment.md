# Interface judgment

Build the smallest complete interface that serves the requested task. Each visible element should add information, enable an action, or provide necessary context. Correct tokens alone do not make a clear interface. Apply this guidance to custom markup, new routes, composed components, and revisions to existing screens.

### Start with what the app already provides

Inspect the surrounding navigation, breadcrumbs, actions, and layout before adding page content. If the breadcrumb already provides the required return route, another back row usually adds no value. Preserve additional navigation when it has a distinct purpose or is needed in a different responsive context.

A page title and useful metadata are a sufficient starting point. Authorship, ownership, last-updated information, or a relevant reporting period can help readers assess the content. Include only information the app actually knows. Add a subtitle, category label, status badge, or introduction when it supplies missing context; do not add them as standard decoration above every page. Put the requested summary in the content, without another version under the title.

### Give information a clear home

Assign each fact a primary place. Use summary prose to explain significance, a KPI to highlight a value, a chart to expose a trend or comparison, and a table for exact lookup. These can coexist when they answer different questions. Avoid repeating the same headline value in prose, a KPI, and a chart header at equal emphasis. A chart's plotted values and an expandable data table can repeat the underlying data because they support different tasks.

Keep chart titles descriptive. Add captions only for interpretation or context the surrounding content does not provide. Retain units, series identification, meaningful date ranges, and definitions needed to read the chart. If several views share a period, state it at their common scope when that remains clear; identify different periods where necessary.

After a disclosure such as “View monthly data,” reveal the data directly. Use the existing heading or disclosure label to name the region or table where appropriate; add a visible caption only if it contributes new information. Preserve semantic table headers and accessible names. If data is illustrative, communicate that once in a relevant location without repeating a sample-data badge and disclaimer throughout the page.

### Reuse a small visual vocabulary

Choose the smallest useful subset of the active theme's text steps, font roles, and weights. A new section does not automatically need a new style. Give peer card and chart headings the same text size and weight, and keep equivalent values, labels, and metadata consistent across views. A page title or focal metric can have a distinct role when that difference explains the hierarchy. Semantic heading levels and visual styles are separate: preserve a meaningful document outline while styling peers consistently.

Use regular paragraph text by default. Emphasize a phrase when it materially helps scanning or understanding; avoid bolding a metric simply because it is a number, especially when a nearby callout already gives it prominence. Use spacing and grouping before adding another font size, weight, color, surface, or divider. Keep the chosen theme's character and existing component treatments.

### Make widths and alignment deliberate

Set prose in a readable column and align related headings, paragraphs, and data regions to a shared grid. Short copy can end before the right edge. A wider chart or table can sit below narrower prose when the relationship is clear. Avoid an unexplained inner text width inside a much wider bordered or filled container; choose the container and text widths together. Do not justify text, add filler, or enlarge type to make a paragraph fill a box. Reflow the layout on narrow screens while retaining readable type and controls.

### Keep visual cues consistent with behavior

Render fixed dates and other read-only values as metadata. Use the existing control treatment for values the user can change. Do not give a static label a button-like surface, hover state, chevron, or pointer cursor. Equivalent controls should look and behave consistently; use one shared control when it changes the same input across multiple views. Add an interaction only when it serves the task and has real behavior.

### Finish by removing what adds nothing

Review the normal page and expanded states within the project's review workflow. Remove repeated navigation, labels, facts, captions, and style variations when doing so preserves meaning and usability. Keep the requested content, essential qualifications, accessible structure, useful metadata, and cues needed to act. This is a judgment standard, not a fixed report layout or a ban on subtitles, captions, cards, or emphasis.
