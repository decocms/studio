---
name: templating
description: Render any text file (HTML, markdown, config, SQL, email) from a mustache template plus JSON data. Use when an output's shape is fixed ahead of time and only the values change.
---

# templating — fill data into text-file templates

Render any text file (HTML, markdown, config, SQL, email, …) from a
mustache template plus JSON data. Use this whenever the shape of an output
is known ahead of time and only the values change — it is faster and less
error-prone than writing the file by hand.

Other skills build on this one (e.g. `slides` composes presentation decks
from slide templates).

## Quick reference

| Task                       | Command                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| Render with inline data    | `create-from-template --template t.html --data '{"name":"Ada"}' --output out.html` |
| Render with a data file    | `create-from-template --template t.html --data @data.json --output out.html` |
| Fail on missing keys       | add `--strict`                                                            |
| Overwrite existing output  | add `-f`                                                                  |
| Use partials (`{{>name}}`) | add `--partials-dir ./partials`                                           |

The command prints the absolute output path on success and exits non-zero
with a message on any error (bad JSON, missing template, existing output
without `-f`, missing keys under `--strict`).

## Template syntax (mustache)

| Syntax                | Meaning                                                       |
| --------------------- | ------------------------------------------------------------- |
| `{{name}}`            | Insert value, HTML-escaped                                    |
| `{{{name}}}`          | Insert value raw (no escaping) — for trusted HTML fragments   |
| `{{#items}}…{{/items}}` | Repeat block for each array item; also renders for truthy values |
| `{{.}}`               | The current item inside a list block                          |
| `{{^items}}…{{/items}}` | Render block only when the value is empty/falsy/missing     |
| `{{user.name}}`       | Dotted path lookup                                            |
| `{{>header}}`         | Include partial `header` (resolved from `--partials-dir` as `header` or `header.html`) |
| `{{!comment}}`        | Comment, never rendered                                       |

Example:

```html
<ul>
  {{#items}}<li><b>{{label}}</b>: {{value}}</li>{{/items}}
  {{^items}}<li>No items</li>{{/items}}
</ul>
```

```sh
create-from-template --template list.template.html \
  --data '{"items":[{"label":"CPU","value":"42%"}]}' \
  --output list.html
```

## Workflow tips

- Keep data in a JSON file (`--data @data.json`) when it is more than a
  couple of fields — easier to iterate on than a long inline string.
- Use `--strict` while developing a template to catch typos in key names;
  drop it when optional keys are intentional.
- Templates are plain text files — author your own anywhere (the org home
  folder under `org/<slug>/templates/` is a good durable place for
  organization-wide templates).
