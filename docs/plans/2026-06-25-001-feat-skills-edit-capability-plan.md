---
type: plan
title: "feat: Add edit capability to Claude Code skills registry"
date: 2026-06-25
status: draft
origin: tmp/compound-engineering/ce-brainstorm/litellm-skills-edit/grounding.md
---

**Target repo:** litellm

---

## Summary

Add admin edit functionality to the Claude Code plugin/skills registry. Currently admins can register (create) and delete skills but cannot edit them after registration. This plan adds a dedicated `PATCH /claude-code/plugins/{name}` backend endpoint, an `EditPluginForm` modal pre-populated from the existing plugin object, an edit button in the `PluginTable` actions column, and an Edit button in the `SkillDetail` view. Plugin `name` is immutable — it is the database unique key.

---

## Problem Frame

The Claude Code skills admin UI (the "Skills" page at `/skills`) exposes a read-only `SkillDetail` view and a `PluginTable` with only a delete action in the admin actions column. There is no HTTP endpoint for partial updates to an existing plugin, no edit form, and no edit entry point in the UI. Admins who want to change a skill's description, source, version, or metadata must delete and re-register it — losing the creation timestamp and `created_by` provenance.

The `POST /claude-code/plugins` handler performs an upsert (creates or updates based on `name`), but this is undifferentiated from new registration at the API level and has no corresponding UI edit path.

---

## Requirements

- **R1** Admin users can edit all mutable fields of an existing skill: `source`, `version`, `description`, `author`, `homepage`, `keywords`, `category`, `domain`, `namespace`.
- **R2** Plugin `name` is not editable — displayed in the edit form as a disabled read-only field.
- **R3** `created_by` and `created_at` are not modified on update.
- **R4** Edit is accessible from two entry points: the edit icon in the `PluginTable` admin actions column, and an "Edit" button in `SkillDetail` (admin only).
- **R5** Backend exposes a dedicated `PATCH /claude-code/plugins/{name}` endpoint requiring admin authentication.
- **R6** Source format is validated on update using the same validation logic as registration.
- **R7** On successful edit the plugin list refreshes and the edit modal closes.

---

## Key Technical Decisions

**KTD1 — Dedicated PATCH endpoint over POST upsert reuse.**
The existing `POST /claude-code/plugins` doubles as upsert but its semantics communicate "register". A distinct `PATCH /claude-code/plugins/{name}` makes the API contract explicit: update-only, cannot create a new record, 404 on unknown name. The existing upsert logic in POST is left unchanged for backwards compatibility.

**KTD2 — Separate `EditPluginForm` over refactoring `AddPluginForm`.**
The add and edit forms share the same fields but differ in initialization (empty vs. pre-populated), `name` field behavior (editable vs. disabled), and submit action (POST vs. PATCH). A separate `EditPluginForm` avoids touching the registration flow and limits blast radius. Field-level deduplication into a shared base can be addressed in a follow-up.

**KTD3 — Edit state lives in the panel orchestrator.**
`pluginToEdit` and `isEditModalVisible` belong in `ClaudeCodePluginsPanel`, mirroring the existing delete state pattern (`pluginToDelete`, `isDeleting`). Child components (`PluginTable`, `SkillDetail`) receive only an `onEditClick` callback and remain stateless.

---

## Scope Boundaries

### In scope
- `PATCH /claude-code/plugins/{name}` backend endpoint and `UpdatePluginRequest` type
- `updateClaudeCodePlugin` networking function
- `EditPluginForm` modal component
- Edit icon button in `PluginTable` actions column (admin only)
- Edit button in `SkillDetail` header (admin only)
- Edit state and handler wiring in `ClaudeCodePluginsPanel`

### Deferred to Follow-Up Work
- Refactoring `AddPluginForm` and `EditPluginForm` into a shared `PluginFormFields` base
- Audit log / who-last-edited tracking
- Front-end dirty-field detection (submit only changed fields)

### Out of scope
- Anthropic `/v1/skills` passthrough (separate system, separate DB model `LiteLLM_SkillsTable`)
- Plugin name renaming
- `created_by` / `created_at` modification

---

## Implementation Units

### U1. Backend — `UpdatePluginRequest` type and PATCH endpoint

**Goal:** Expose `PATCH /claude-code/plugins/{name}` for admin-only partial updates to an existing plugin.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** none

**Files:**
- `litellm/types/proxy/claude_code_endpoints.py` — add `UpdatePluginRequest`
- `litellm/proxy/anthropic_endpoints/claude_code_endpoints/claude_code_marketplace.py` — add PATCH route handler
- `tests/proxy_unit_tests/test_claude_code_marketplace.py` — new or extended test cases

**Approach:**
`UpdatePluginRequest` mirrors `RegisterPluginRequest` with all fields optional and `name` omitted (name is the URL path parameter). Add a `PATCH /claude-code/plugins/{plugin_name}` route. The handler: look up the existing record by `plugin_name`; raise 404 if not found. Load the existing `manifest_json`, merge only the provided (non-None) request fields on top, then write back the updated manifest and fields to the DB. Reuse `_validate_plugin_source` for source validation when `source` is provided. Leave `created_by`, `created_at` unchanged. Return a response matching the shape of `register_plugin`'s success response with `action: "updated"`.

**Patterns to follow:** `register_plugin` handler at `claude_code_marketplace.py:191`; `_validate_plugin_source` at `claude_code_marketplace.py`; `ClaudeCodePluginRepository` table operations throughout.

**Test scenarios:**
- Happy: PATCH with valid `description` and `version` → DB record updated, `updated_at` advances, `created_at` and `created_by` unchanged.
- Happy: PATCH with only `source` → manifest updated, other fields preserved.
- Happy: PATCH with all mutable fields → full manifest rebuild matches submitted values.
- Edge: PATCH with empty body (all fields None) → 200, no-op, existing values preserved.
- Error: PATCH `nonexistent-plugin` → 404.
- Error: PATCH with `source: {source: "github"}` missing `repo` → 400.
- Error: non-admin key → 403.

**Verification:** PATCH to a registered plugin returns 200 with `action: updated`; subsequent GET for the same plugin reflects the new values.

---

### U2. Frontend networking — `updateClaudeCodePlugin`

**Goal:** Add a networking function wrapping the PATCH endpoint, following existing module patterns.

**Requirements:** R5, R7

**Dependencies:** U1

**Files:**
- `ui/litellm-dashboard/src/components/networking.tsx`

**Approach:**
Add `updateClaudeCodePlugin(accessToken: string, pluginName: string, updateData: Partial<Omit<Plugin, "id" | "name" | "enabled" | "created_at" | "updated_at" | "created_by">>)` near the existing `registerClaudeCodePlugin` at line ~7404. Constructs `PATCH /claude-code/plugins/{pluginName}`, sets `Authorization: Bearer {accessToken}` and `Content-Type: application/json`, sends `updateData` as the body. Follow the same error-handling and base-URL resolution pattern as `registerClaudeCodePlugin` and `deleteClaudeCodePlugin`.

**Patterns to follow:** `registerClaudeCodePlugin` at `networking.tsx:7404`; `deleteClaudeCodePlugin` at `networking.tsx:7520`.

**Test scenarios:**
- Happy: function builds PATCH request with correct URL and Authorization header.
- Happy: 200 response returns parsed JSON.
- Error: non-200 response is thrown as an error.

**Verification:** Browser dev tools show a PATCH request to `/claude-code/plugins/{name}` with the correct headers when a user saves the edit form.

---

### U3. `EditPluginForm` component

**Goal:** A modal form pre-populated from an existing `Plugin` object that submits a PATCH update.

**Requirements:** R1, R2, R4, R7

**Dependencies:** U2

**Files:**
- `ui/litellm-dashboard/src/components/claude_code_plugins/edit_plugin_form.tsx` — new file

**Approach:**
Props: `visible: boolean`, `plugin: Plugin | null`, `onClose: () => void`, `accessToken: string | null`, `onSuccess: () => void`.

On `visible` + `plugin` change, populate the Ant Design `Form` instance via `form.setFieldsValue(...)` with values extracted from `plugin`. The `name` field is rendered as a disabled `<Input>` so admins can see which plugin they are editing. For the source field, extract source type and repo/url/path from `plugin.source` to pre-populate the same source-type selector and conditional inputs used in `AddPluginForm`.

Submit handler: build `updateData` from form values excluding `name`, call `updateClaudeCodePlugin(accessToken, plugin.name, updateData)`. On success: `MessageManager.success(...)`, call `onSuccess()`, call `onClose()`. On error: `MessageManager.error(...)` without closing.

Reuse `PREDEFINED_CATEGORIES`, `isValidSemanticVersion`, `isValidEmail`, `isValidUrl`, and `parseKeywords` from `helpers.ts`.

**Patterns to follow:** `AddPluginForm` at `claude_code_plugins/add_plugin_form.tsx` — form layout, `Modal` wrapper, `MessageManager` usage, `Form`/`Input`/`Select`/`TextArea` composition.

**Test scenarios:**
- Happy: opening form with a plugin pre-fills all non-null fields including source type, description, version, category.
- Happy: submitting with changed description calls `updateClaudeCodePlugin` with the correct payload.
- Happy: on successful save, `onSuccess` and `onClose` are both called.
- Edge: `name` field is disabled — cannot be focused or changed by the user.
- Edge: submitting unchanged values still sends the PATCH (no client-side diff guard).
- Error: PATCH fails → error message shown, modal stays open.

**Verification:** Open the edit modal for a skill, change description, save, confirm list view reflects the updated description without a page reload.

---

### U4. `PluginTable` edit button

**Goal:** Add an edit (pencil) icon button to the admin actions column that calls a new `onEditClick` callback.

**Requirements:** R4

**Dependencies:** U3 (UI cohesion — button opens `EditPluginForm`)

**Files:**
- `ui/litellm-dashboard/src/components/claude_code_plugins/plugin_table.tsx`

**Approach:**
Add `onEditClick: (plugin: Plugin) => void` to `PluginTableProps`. In the actions column (currently containing only the delete button at lines 144–172), add an edit button placed before the delete button. Use the same `Button` + `Tooltip` wrapper pattern. Icon: `EditOutlined` from `@ant-design/icons`. Call `e.stopPropagation()` to prevent row-click navigation to `SkillDetail`. Render only when `isAdmin` is true.

**Patterns to follow:** Delete button at `plugin_table.tsx:144–172`.

**Test scenarios:**
- Happy: edit button renders in the actions column for admin users.
- Happy: clicking edit calls `onEditClick` with the correct `Plugin` object.
- Happy: clicking edit does not trigger row-click navigation (stopPropagation).
- Edge: edit button does not render for non-admin users.

**Verification:** As admin, the Skills table shows both edit and delete icons in the actions column; clicking edit opens the edit form for the correct skill.

---

### U5. `SkillDetail` edit button

**Goal:** Add an "Edit" button to the `SkillDetail` header, visible to admins.

**Requirements:** R4

**Dependencies:** U3 (UI cohesion)

**Files:**
- `ui/litellm-dashboard/src/components/claude_code_plugins/skill_detail.tsx`

**Approach:**
Add `onEditClick?: () => void` to `SkillDetailProps`. The component function at line 14 currently only destructures `{ skill, onBack }` — expand the destructuring to include `isAdmin` and `onEditClick` (both already present in the interface but unused). Render a `<Button>` labeled "Edit" in the header area (near or alongside the back link at line 51) when `isAdmin && onEditClick`. Use the Tremor `Button` import consistent with other components in this directory.

**Patterns to follow:** Header layout at `skill_detail.tsx:49–73`; `Button` usage in `add_plugin_form.tsx`.

**Test scenarios:**
- Happy: "Edit" button is visible in the detail view for admin users when `onEditClick` is provided.
- Happy: clicking "Edit" calls `onEditClick`.
- Edge: "Edit" button not rendered when `isAdmin` is false.
- Edge: "Edit" button not rendered when `onEditClick` is undefined.

**Verification:** Navigating to a skill's detail page as admin shows an "Edit" button that opens the edit modal for that skill.

---

### U6. `ClaudeCodePluginsPanel` — edit state wiring

**Goal:** Wire all edit-flow pieces into the panel orchestrator: state, handlers, props to table and detail, and rendering `EditPluginForm`.

**Requirements:** R4, R7

**Dependencies:** U3, U4, U5

**Files:**
- `ui/litellm-dashboard/src/components/claude_code_plugins.tsx`

**Approach:**
Add state: `pluginToEdit: Plugin | null` (default `null`) and `isEditModalVisible: boolean` (default `false`).

Add `handleEditClick(plugin: Plugin)`: sets `pluginToEdit(plugin)` and `setIsEditModalVisible(true)`.

Add `handleEditClose()`: sets `isEditModalVisible(false)` and clears `pluginToEdit(null)`.

Pass `onEditClick={handleEditClick}` to `<PluginTable>`.

Pass `onEditClick={() => selectedSkill && handleEditClick(selectedSkill)}` and the already-computed `isAdmin` to `<SkillDetail>` (note: `isAdmin` is currently passed to `SkillDetail` via props but the component body silently drops it — U5 fixes that on the receiving end).

Render `<EditPluginForm visible={isEditModalVisible} plugin={pluginToEdit} onClose={handleEditClose} accessToken={accessToken} onSuccess={fetchPlugins} />` adjacent to the existing `<AddPluginForm>` at the bottom of the component.

**Patterns to follow:** Delete state handling (`pluginToDelete`, `isDeleting`, `handleDeleteClick`, `handleDeleteConfirm`) in `claude_code_plugins.tsx`.

**Test scenarios:**
- Happy: clicking edit icon in table opens `EditPluginForm` pre-loaded with the correct plugin.
- Happy: clicking "Edit" in `SkillDetail` opens `EditPluginForm` for the currently viewed skill.
- Happy: after successful edit, `fetchPlugins()` refreshes the table.
- Happy: closing the modal without saving does not trigger a refresh.
- Edge: re-navigating to `SkillDetail` for the edited plugin after saving shows the updated fields.

**Verification:** Full flow — click edit on a table row, change description, save, confirm table shows the updated description. Repeat from `SkillDetail` view.

---

## Open Questions

- **Q1 (deferred):** Should the PATCH response return the full `PluginListItem` shape so the panel can update `selectedSkill` in-place without a follow-up GET? The minimal `PluginResponse` shape is sufficient for now; can be upgraded when in-place refresh is needed.
- **Q2 (existing inconsistency, not introduced here):** `PluginListItem` backend type omits `created_by`, but the frontend `Plugin` TS interface includes it. Editing does not worsen this gap but it means `created_by` in the list view is always undefined.

---

## Risks & Dependencies

- **Source type pre-population in `EditPluginForm`:** Parsing `plugin.source` to pre-fill the source-type selector and conditional repo/url/path inputs requires handling all three source variants (`github`, `url`, `git-subdir`). Add a fallback that logs a warning and defaults to the raw source value if the type is unrecognized.
- **`SkillDetail` silent prop drop:** The component declares `isAdmin` and `accessToken` in its props interface but the function body drops them (`{ skill, onBack }`). U5 expands the destructuring. This is safe but worth noting in code review.
- **DB upsert via POST is unchanged:** The existing `POST /claude-code/plugins` upsert path remains functional. If an admin uses the Add form with an existing plugin name, they will silently overwrite it. This pre-existing behavior is not changed by this plan.

---

## Sources & Research

- Grounding dossier: `tmp/compound-engineering/ce-brainstorm/litellm-skills-edit/grounding.md`
- Backend reference: `litellm/proxy/anthropic_endpoints/claude_code_endpoints/claude_code_marketplace.py`
- Types: `litellm/types/proxy/claude_code_endpoints.py`
- Frontend panel: `ui/litellm-dashboard/src/components/claude_code_plugins.tsx`
- Add form (pattern reference): `ui/litellm-dashboard/src/components/claude_code_plugins/add_plugin_form.tsx`
- Table: `ui/litellm-dashboard/src/components/claude_code_plugins/plugin_table.tsx`
- Detail view: `ui/litellm-dashboard/src/components/claude_code_plugins/skill_detail.tsx`
- Networking: `ui/litellm-dashboard/src/components/networking.tsx`
