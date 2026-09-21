# GPMC-style ADMX policy editor

Replaces the old facet tree + the "compose" stack with a real Administrative
Templates editor: an OS-filtered ADMX **category tree**, a **policy list**, and a
per-policy **detail editor** whose controls are rendered from the ADMX/ADML
template — with a proper ADMX → registry.pol compiler behind Save.

## Backend

The ADMX pipeline was extended from "flat on/off value per policy" to the full
policy schema, and the persistent catalog cache (`CATALOG_CACHE_VERSION = 2`) now
stores, per ADMX file, `{policies, meta, presentations}`:

- **`parse_admx`** captures per policy: `category` (parentCategory ref),
  `supported` (supportedOn ref), `presentation`, `enabled/disabled` value(s),
  `enabled_list`/`disabled_list`, and full `elements[]`. `_admx_element` captures
  every element's control data: enum `items[{display,value,type}]`, decimal
  `min/max/store_as_text`, text `maxlen/expandable`, boolean `true_value/false_value`,
  list `list_key/value_prefix/explicit/additive`, and `required`.
- **`parse_admx_meta`** captures the namespace + `using`/target prefixes +
  `<categories>` for the tree.
- **`parse_adml_presentations`** captures each policy's presentation controls
  (control type, label, default, default_item) from the ADML.
- Category display names, enum item labels, and policy display/explain are
  resolved from the ADML.

### Verbs

| Verb | What |
|---|---|
| `gpo-edit-context --gpo` | Editor bootstrap: resolve + **declare** the GPO's OS scope (set if missing), return the OS-filtered category tree. |
| `gpo-policy-tree [--os]` | ADMX category tree (folders + counts), OS-filtered. |
| `gpo-policy-list --category [--os]` | Policies directly in one category. |
| `gpo-policy-schema --id` | Full schema for one policy: explain/class/supported-on + each element merged with its presentation (control, label, default, items). |
| `gpo-policy-read --gpo --id` | Decode registry.pol → the policy's current state + element values (pre-fill). |
| `gpo-policy-compile --gpo --id --state [--values --class --apply]` | Compile a policy's state + element values into registry.pol writes; `apply=true` applies (gpo load/remove), `apply=false` previews. Auto-declares the GPO OS if missing. |

### The compiler (`_compile_policy`)

The single place element values become registry writes. Element → registry:

| ADMX element | Control | Registry write |
|---|---|---|
| `boolean` | checkbox | `true_value`/`false_value`, REG_DWORD |
| `decimal` / `longDecimal` | number (min/max) | REG_DWORD/REG_QWORD (REG_SZ if `store_as_text`) |
| `text` | text (maxlen) | REG_SZ (REG_EXPAND_SZ if `expandable`) |
| `multiText` | textarea | REG_MULTI_SZ |
| `enum` | dropdown of items | the selected item's value, at the item's REG type |
| `list` | line list | one REG_SZ row per entry, `value_prefix`+N under `list_key`; `explicit` → `name=value` |
| *(policy base)* | the tri-state | `enabled/disabled` value, or `enabled_list/disabled_list` rows; implicit 1/0 when a base `valueName` has no explicit value |

- **Not Configured** removes the policy's base + every element value.
- **Disabled** writes the disabled value(s) and removes element values.
- OS gate: an ADMX policy carries an authoritative OS; the compiler refuses a
  cross-OS write rather than trusting the per-key namespace heuristic.

## Frontend (`gpoEditModal`)

1. On open, `gpo-edit-context` resolves + locks the GPO's OS (a badge, not a
   selectable chip — set now if it was missing) and draws the category tree.
2. The left docked tree is the ADMX category hierarchy (collapsible, filterable);
   clicking a folder lists its policies on the right.
3. Opening a policy shows Supported-on, help text, an
   **Enabled / Disabled / Not Configured** control, and one control per element
   (dropdown / checkbox / number with min/max / free text / list), pre-filled from
   `gpo-policy-read`. Element controls are active only when Enabled.
4. Save validates (required + decimal min/max) and calls `gpo-policy-compile`
   `apply=true`.

The "compose" modal (and its raw layer stack) is removed. Raw registry viewing
stays under a GPO's **settings** (gpo-detail); the raw `gpo-settings-apply/remove`
verbs remain for CLI use.

## Validation

Unit tests cover the parsers, category-tree resolution/pruning, schema
element↔presentation join, and the `_compile_policy` round-trip (every element
kind, enabledList, notconfigured removals, required-missing). Validated live
against the 233-file central store: the tree (Windows Components 2400+, System,
Network …), typed schema (decimal min/max, enum items, dropdown/decimalTextBox
controls), and a compile→apply→read round-trip on a scratch GPO (decimal 42, enum
1 → registry.pol → read back → notconfigured removes). UI validated in the
mock-cockpit harness (tree → policy list → all four control types, tri-state
gating, min/max validation, Save).
