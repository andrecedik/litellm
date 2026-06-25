# Skills Gateway — Edit (Update) Feature Design

**Date:** 2026-06-25
**Scope:** `litellm_proxy` path only (Anthropic provider raises "not supported")
**HTTP method:** `PATCH /v1/skills/{skill_id}`
**SDK functions:** `litellm.update_skill()` / `litellm.aupdate_skill()`

---

## Goal

Add a partial-update operation for skills stored in the LiteLLM proxy database. The existing Skills API has create, list, get, and delete — edit is the missing operation. Scope is intentionally limited to `custom_llm_provider="litellm_proxy"`; the Anthropic provider path raises `ValueError` and can be extended later if Anthropic exposes an update endpoint.

---

## Architecture

The feature follows the same six-layer pattern used by every other skill operation:

```
FastAPI endpoint (skills_endpoints.py)
  → ProxyBaseLLMRequestProcessing (route_type="aupdate_skill")
    → route_request() dispatch (route_llm_request.py)
      → litellm.aupdate_skill() (skills/main.py)
        → LiteLLMSkillsTransformationHandler.update_skill_handler()
          → LiteLLMSkillsHandler.update_skill()   ← DB write
```

---

## File-by-file changes

### 1. Types — `litellm/types/llms/anthropic_skills.py`

Add `UpdateSkillRequest` TypedDict alongside the existing request types:

```python
class UpdateSkillRequest(TypedDict, total=False):
    display_title: Optional[str]
    description: Optional[str]
    instructions: Optional[str]
    files: Optional[List[Any]]
    metadata: Optional[Dict[str, Any]]
```

Response type is the existing `Skill` — no new type needed.

`litellm/proxy/_types.py` already contains `UpdateSkillRequest` (line 1510) with
`file_content`, `file_name`, `file_type` fields. That type is used by the DB handler
and is not modified.

### 2. DB handler — `litellm/llms/litellm_proxy/skills/handler.py`

Add `update_skill` static method to `LiteLLMSkillsHandler`:

- Load skill via `_load_skill` (cache-first).
- Apply same ownership check as `get_skill` / `delete_skill` (opaque "Skill not found" for both missing and unauthorized).
- Build `update_data` dict with only the fields that are not `None` (partial update — no accidental nulling of existing values).
- Call `SkillsRepository(prisma_client).table.update(where={"skill_id": skill_id}, data=update_data)`.
- Set the returned Prisma row into `_SKILL_CACHE` (warm cache hit on next `get_skill`, avoids unnecessary DB round-trip).
- Return `_prisma_skill_to_litellm(updated)`.

`updated_by` is always written using `get_primary_resource_owner_scope(user_api_key_dict)`.

### 3. Transformation handler — `litellm/llms/litellm_proxy/skills/transformation.py`

Add `update_skill_handler` (sync/async toggle, same pattern as `delete_skill_handler`) and `_async_update_skill` to `LiteLLMSkillsTransformationHandler`:

- `files` → `file_content` extraction uses the same tuple-unpacking logic as `create_skill_handler`.
- Constructs `UpdateSkillRequest` from `litellm.proxy._types` and delegates to `LiteLLMSkillsHandler.update_skill`.
- Returns `self._db_skill_to_response(db_skill)` — no new serialisation logic.

### 4. SDK — `litellm/skills/main.py`

Add `update_skill` (sync) and `aupdate_skill` (async wrapper), mirroring `delete_skill` / `adelete_skill`:

- Parameters: `skill_id`, `display_title`, `description`, `instructions`, `files`, `metadata`, `extra_headers`, `extra_body`, `timeout`, `custom_llm_provider`, `**kwargs`.
- Default provider: `"anthropic"` (same as all other skill functions).
- `litellm_proxy` branch: routes to `_get_litellm_skills_handler().update_skill_handler(...)`.
- All other providers: `raise ValueError(f"UPDATE skill is not supported for {custom_llm_provider}")`.
- No `BaseSkillsAPIConfig` / HTTP handler path needed.

**`litellm/__init__.py`** — add `update_skill, aupdate_skill` to the Skills API import block alongside the existing four pairs.

### 5. FastAPI endpoint — `litellm/proxy/anthropic_endpoints/skills_endpoints.py`

Add `PATCH /v1/skills/{skill_id}`:

- Reads multipart form data via `get_form_data` + `convert_upload_files_to_file_data` (same as `create_skill` — supports file uploads).
- Sets `data["skill_id"] = skill_id` from path parameter.
- Model routing via `x-litellm-model` header / query / form field (same pattern as all other endpoints).
- Dispatches via `processor.base_process_llm_request(..., route_type="aupdate_skill")`.
- `response_model=Skill`.

### 6. Route dispatch — `litellm/proxy/route_llm_request.py`

Two additions:

```python
# URL map (~line 116)
"aupdate_skill": "/skills/{skill_id}",

# No-model dispatch list (~line 537) — same group as acreate_skill … adelete_skill
"aupdate_skill",
```

### 7. Common request processing — `litellm/proxy/common_request_processing.py`

Add `"aupdate_skill"` to both `Literal` type unions (first occurrence ~line 992, second ~line 1269).

---

## Partial update semantics

Only fields explicitly set to a non-`None` value in the request body are written to the database. Fields absent from the request are left unchanged. This means:

- `PATCH /v1/skills/sk_123` with `{"display_title": "New Name"}` updates only the title.
- `description` and all other fields retain their current values.

This is enforced in the DB handler by building `update_data` conditionally, not by passing `None` to Prisma.

---

## Cache behaviour

On update, the fresh Prisma row is written back into `_SKILL_CACHE` under `skill_id`. This keeps the 60-second LRU cache warm and means the next `get_skill` call is a cache hit with correct data. (Compare: `delete_skill` writes `_NEGATIVE_SKILL_SENTINEL` to prevent ghost reads.)

---

## Ownership / authorisation

Identical to `get_skill` and `delete_skill`:

- Load skill (cache-first).
- Call `user_can_access_resource_owner(skill.created_by, user_api_key_dict)`.
- Return the same `ValueError("Skill not found: {skill_id}")` for both "does not exist" and "wrong owner" — callers cannot enumerate skill IDs they don't own.

---

## Error handling

| Condition | Response |
|---|---|
| Skill not found | `ValueError("Skill not found: {skill_id}")` → 404 via existing exception handler |
| Caller does not own skill | Same as above (opaque) |
| `custom_llm_provider` ≠ `litellm_proxy` | `ValueError("UPDATE skill is not supported for {provider}")` → 400 |
| No identity scope on caller | Caught by existing pre-call auth (`user_api_key_auth` dep) |

---

## Tests

No new test files. Add to existing files:

**`tests/proxy_unit_tests/test_skills_db.py`**
- `test_update_skill_success` — create → update `display_title` + `description` → assert fields changed, `skill_id` unchanged, `updated_at` ≥ `created_at`.
- `test_update_skill_cache_hit` — verify `get_skill` after update reads from cache (no second DB call).
- `test_update_skill_wrong_id` — assert `ValueError` raised.
- `test_update_skill_cross_tenant` — assert `ValueError` raised when caller owns a different skill.

**`tests/llm_translation/test_skills_api.py`**
- `test_aupdate_skill_litellm_proxy` — async SDK call with `custom_llm_provider="litellm_proxy"` returns updated `Skill`.
- `test_update_skill_sync` — sync wrapper returns same result.
- `test_update_skill_anthropic_raises` — `custom_llm_provider="anthropic"` raises `ValueError`.

---

## Out of scope

- Anthropic provider path (no known update endpoint; add later if needed).
- `BaseSkillsAPIConfig` abstract methods for update (not needed until a second provider is added).
- Versioning: updating file content does not auto-increment `latest_version` — that field is managed separately by the skill versioning API.
