#!/usr/bin/env node
/**
 * Gravity MCP Server
 * Model Context Protocol server for Gravity Forms
 * Tools for forms, entries, and add-ons
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import GravityFormsClient from './gravity-forms-client.js';
import { createFieldOperations, fieldOperationHandlers, fieldOperationTools } from './field-operations/index.js';
import fieldRegistry from './field-definitions/field-registry.js';
import FieldAwareValidator from './config/field-validation.js';
import logger from './utils/logger.js';
import { sanitize } from './utils/sanitize.js';
import { stripEmpty, stripEntryMetaFromResponse } from './utils/compact.js';
import { timingSafeEqual } from 'crypto';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Load environment variables:
// 	1. Current working directory first
dotenv.config({ path: join(process.cwd(), '.env') });
// 	2. Gravity MCP project directory
dotenv.config({ path: join(__dirname, '..', '.env') });

const mcpToken = process.env.GRAVITY_MCP_TOKEN;
if (!mcpToken) {
  logger.error('GRAVITY_MCP_TOKEN environment variable is required');
  process.exit(1);
}

// Initialize the MCP server
const server = new Server(
  {
    name: 'gravitykit-mcp',
    version: '2.1.0'
  },
  {
    capabilities: {
      tools: {}
    },
    instructions: 'GravityKit MCP server for Gravity Forms. All responses strip null and empty values by default for minimal token usage. Pass compact=false on any tool to get full raw data. Entry tools also strip plugin-added meta keys; use compact=false to include them.'
  }
);
// Global client instance
let gravityFormsClient = null;
let fieldOperations = null;
let fieldValidator = null;
/**
 * Initialize Gravity Forms client
 */
async function initializeClient() {
  try {
    gravityFormsClient = new GravityFormsClient(process.env);
    const validation = await gravityFormsClient.initialize();
    if (!validation.available) {
      throw new Error(`Failed to initialize Gravity Forms client: ${validation.error}`);
    }
    // Initialize field operations infrastructure
    fieldValidator = new FieldAwareValidator();
    fieldOperations = createFieldOperations(
      gravityFormsClient,
      fieldRegistry,
      fieldValidator
    );
    logger.info('✅ GravityKit MCP initialized successfully');
    logger.info('✅ Field operations infrastructure initialized');
    return true;
  } catch (error) {
    logger.error(`❌ Failed to initialize: ${error.message}`);
    throw error;
  }
}
/**
 * Recursively strip null, empty string, and false values from objects/arrays.
 * Reduces token usage by removing noise like empty field values and absent meta keys.
 */
/**
 * Create standard error response
 */
function createErrorResponse(message, details = null) {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${message}${details ? `\nDetails: ${JSON.stringify(details)}` : ''}`
      }
    ],
    isError: true
  };
}
/**
 * Wrap async handler with error handling and response compaction.
 * @param {Function} handler - async function returning result object
 * @param {object} params - tool params; if compact !== false, strips null/empty/false values
 */
function wrapHandler(handler, params = {}) {
  return async () => {
    if (!gravityFormsClient) {
      return createErrorResponse('Gravity Forms client not initialized');
    }
    try {
      const result = await handler();
      const output = params.compact !== false ? stripEmpty(result) : result;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output)
          }
        ]
      };
    } catch (error) {
      const safeDetails = error.details ? sanitize(error.details) : undefined;
      logger.error(`Tool error: ${error.message}`);
      return createErrorResponse(error.message, safeDetails);
    }
  };
}
/**
 * Convert array-of-pairs field_values to a flat object shape.
 *
 * Input:  [{ field_id: "1", value: "text" }, { field_id: "2", value: "other" }]
 * Output: { "1": "text", "2": "other" }
 *
 * The array-of-pairs schema shape is required so each tool's inputSchema can
 * satisfy strict JSON Schema validation (additionalProperties: false) while
 * still accepting an arbitrary number of dynamically-named Gravity Forms
 * field IDs.
 */
function fieldValuesToObject(fieldValuesArray) {
  if (!Array.isArray(fieldValuesArray)) {
    return {};
  }
  return fieldValuesArray.reduce((acc, pair) => {
    if (pair && pair.field_id !== undefined && pair.value !== undefined) {
      acc[String(pair.field_id)] = pair.value;
    }
    return acc;
  }, {});
}
/**
 * Parse a feed's JSON-encoded `meta` string param back into an object.
 * Feed meta shape varies per addon_slug, so it's accepted as a JSON string
 * (rather than a typed object) to satisfy strict JSON Schema validation
 * (additionalProperties: false) while still allowing arbitrary config shapes.
 * Throws a descriptive error on invalid JSON so the caller gets a clear
 * error response instead of an opaque parse failure.
 */
function parseMetaJson(metaString) {
  if (metaString === undefined || metaString === null) {
    return undefined;
  }
  try {
    return JSON.parse(metaString);
  } catch (error) {
    throw new Error(`Invalid JSON in 'meta' parameter: ${error.message}`);
  }
}
/**
 * Core entry columns always kept when field_ids projection is applied,
 * regardless of which field IDs were requested.
 */
const ENTRY_CORE_FIELDS = ['id', 'form_id', 'date_created', 'date_updated', 'status'];
/**
 * Reduce each entry object down to only the requested field IDs (plus core
 * entry columns). Used to keep gf_list_entries responses small when a caller
 * only needs one or two fields (e.g. a tracking-payload field) out of a form
 * that has many fields — avoids returning/transmitting unused field data that
 * can otherwise cause large responses to be truncated downstream.
 *
 * If renameMap is provided (numeric field ID string -> semantic name, as
 * produced by field_names resolution), matching keys are renamed to their
 * semantic name in the output instead of being left as numeric IDs. Fields
 * requested via raw field_ids (no associated name) keep their numeric ID.
 */
function filterEntryFields(entries, fieldIds, renameMap) {
  if (!Array.isArray(fieldIds) || fieldIds.length === 0 || !Array.isArray(entries)) {
    return entries;
  }
  const keepKeys = new Set([...ENTRY_CORE_FIELDS, ...fieldIds.map(String)]);
  const rename = renameMap || {};
  return entries.map((entry) => {
    const filtered = {};
    for (const key of Object.keys(entry)) {
      if (keepKeys.has(key)) {
        const outputKey = rename[key] || key;
        filtered[outputKey] = entry[key];
      }
    }
    return filtered;
  });
}
/**
 * Resolve human-readable field names (matched against inputName, adminLabel,
 * or label, in that priority order, case-insensitively) to numeric field IDs
 * for a single form's field configuration. Field IDs are per-form in Gravity
 * Forms, so this must be run separately for each form being queried.
 *
 * Returns an array of {id, name} pairs (not just bare IDs) so callers can
 * build a rename map for output keys, letting field_names responses use the
 * semantic name as the key instead of the numeric field ID.
 */
function resolveFieldIdsByName(formFields, names) {
  if (!Array.isArray(formFields) || !Array.isArray(names) || names.length === 0) {
    return [];
  }
  const lowerToOriginal = new Map(names.map((n) => [String(n).toLowerCase(), n]));
  const resolved = [];
  for (const field of formFields) {
    const candidates = [field.inputName, field.adminLabel, field.label]
      .filter((v) => v !== undefined && v !== null && v !== '')
      .map((v) => String(v).toLowerCase());
    const match = candidates.find((c) => lowerToOriginal.has(c));
    if (match !== undefined && field.id !== undefined) {
      resolved.push({ id: String(field.id), name: lowerToOriginal.get(match) });
    }
  }
  return resolved;
}
/**
 * Normalize a date_created filter value to the format Gravity Forms' search
 * API actually expects: "YYYY-MM-DD HH:MM:SS" (space-separated, no T/Z).
 * Tolerates common LLM-generated alternatives so a wrong-but-close date
 * format doesn't silently fail or get rejected:
 *   - ISO 8601 with T and optional Z/offset/milliseconds, e.g.
 *     "2026-06-01T00:00:00Z" or "2026-06-01T00:00:00.000+00:00"
 *   - Bare date "2026-06-01" is left as-is (ambiguous whether start/end of
 *     day was intended, so no assumption is made there).
 */
function normalizeDateCreatedValue(value) {
  if (typeof value !== 'string') return value;
  const isoMatch = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]} ${isoMatch[2]}`;
  }
  return value;
}
/**
 * Walk a gf_list_entries search object and normalize any date_created
 * field_filters values in place (returns a new object, does not mutate).
 */
function normalizeSearchDateFilters(search) {
  if (!search || !Array.isArray(search.field_filters)) return search;
  return {
    ...search,
    field_filters: search.field_filters.map((filter) => {
      if (filter && filter.key === 'date_created' && typeof filter.value === 'string') {
        return { ...filter, value: normalizeDateCreatedValue(filter.value) };
      }
      return filter;
    }),
  };
}
/**
 * Extract the fields array from a gf_get_form-style response, tolerating a
 * couple of plausible shapes since the exact client return shape isn't
 * pinned down here.
 */
function extractFormFields(formResult) {
  if (!formResult) return [];
  if (Array.isArray(formResult.fields)) return formResult.fields;
  if (formResult.form && Array.isArray(formResult.form.fields)) return formResult.form.fields;
  return [];
}
// =================================
// FORMS MANAGEMENT TOOLS (6)
// =================================
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Forms Management (6 tools)
      {
        name: 'gf_list_forms',
        description: 'List all forms with optional search and pagination.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            include: {
              type: 'array',
              items: { type: 'number' },
              description: 'Form IDs to include'
            },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          },
          additionalProperties: false
        }
      },
      {
        name: 'gf_get_form',
        description: 'Get a form by ID with full field configuration.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Form ID' },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          },
          additionalProperties: false,
          required: ['id']
        }
      },
      {
        name: 'gf_create_form',
        description: 'Create a new form',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Form title' },
            description: { type: 'string', description: 'Form description' },
            fields: {
              type: 'array',
              description: 'Array of field objects',
              items: {
                type: 'object',
                additionalProperties: false
              }
            },
            button: { type: 'object', description: 'Submit button settings', additionalProperties: false },
            confirmations: { type: 'object', description: 'Confirmation settings', additionalProperties: false },
            notifications: { type: 'object', description: 'Notification settings', additionalProperties: false },
            is_active: { type: 'boolean', description: 'Form active state' }
          },
          required: ['title']
        }
      },
      {
        name: 'gf_update_form',
        description: 'Update a form',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Form ID' },
            title: { type: 'string', description: 'Form title' },
            description: { type: 'string', description: 'Form description' },
            fields: {
              type: 'array',
              description: 'Array of field objects',
              items: {
                type: 'object',
                additionalProperties: false
              }
            },
            button: { type: 'object', description: 'Submit button settings', additionalProperties: false },
            confirmations: { type: 'object', description: 'Confirmation settings', additionalProperties: false },
            notifications: { type: 'object', description: 'Notification settings', additionalProperties: false },
            is_active: { type: 'boolean', description: 'Form active state' }
          },
          required: ['id']
        }
      },
      {
        name: 'gf_delete_form',
        description: 'Delete a form (requires ALLOW_DELETE=true)',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Form ID' },
            force: { type: 'boolean', description: 'Permanent delete (vs trash)' }
          },
          additionalProperties: false,
          required: ['id']
        }
      },
      {
        name: 'gf_validate_form',
        description: 'Validate form data',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' },
            field_values: {
              type: 'array',
              description: 'Field values to validate, one entry per field',
              items: {
                type: 'object',
                properties: {
                  field_id: { type: 'string', description: 'Gravity Forms field ID (e.g. "1", "2", "1.3")' },
                  value: { type: 'string', description: 'Value for this field' }
                },
                required: ['field_id', 'value'],
                additionalProperties: false
              }
            }
          },
          additionalProperties: false,
          required: ['form_id']
        }
      },
      // Entries Management (5 tools)
      {
        name: 'gf_list_entries',
        description: 'List/search entries with filtering, sorting, and pagination. ' +
          'There is no separate date-range parameter — filter by date using search.field_filters ' +
          'with key "date_created" (see that field\'s description for the exact syntax). ' +
          'By default this tool automatically fetches every matching page and returns the complete ' +
          'result set in one response (see "auto_paginate" and "is_complete" in the response) — you do ' +
          'not need to manually loop through pages or compare against total_count yourself. ' +
          'Field IDs are assigned per-form and are NOT consistent across different forms — do not assume ' +
          'a field ID that works on one form applies to another. Use "field_names" (not "field_ids") when ' +
          'you know a field by its name/label (e.g. "tracking_payload") but not its numeric ID for a given ' +
          'form; this tool will look it up for you automatically, no separate gf_get_form call required.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Filter by form IDs'
            },
            include: {
              type: 'array',
              items: { type: 'number' },
              description: 'Entry IDs to include'
            },
            exclude: {
              type: 'array',
              items: { type: 'number' },
              description: 'Entry IDs to exclude'
            },
            status: {
              type: 'string',
              enum: ['active', 'spam', 'trash'],
              description: 'Entry status'
            },
            search: {
              type: 'object',
              description: 'Search/filter criteria. To filter by a date range (e.g. "just June leads"), ' +
                'use two field_filters entries on key "date_created" — one with operator ">=" and the ' +
                'start-of-range value, one with operator "<=" and the end-of-range value — combined with ' +
                'mode "all" so both bounds apply together. Example for June 2026: ' +
                '{ "mode": "all", "field_filters": [' +
                '{ "key": "date_created", "operator": ">=", "value": "2026-06-01 00:00:00" }, ' +
                '{ "key": "date_created", "operator": "<=", "value": "2026-06-30 23:59:59" }] }',
              properties: {
                field_filters: {
                  type: 'array',
                  description: 'One condition per entry. Combine with "mode" to control AND/OR logic.',
                  items: {
                    type: 'object',
                    properties: {
                      key: {
                        type: 'string',
                        description: 'Field to filter on. This property MUST be named "key" — not "field_id" ' +
                          'or anything else. Use "date_created" for date-range filtering (value format: ' +
                          '"YYYY-MM-DD HH:MM:SS", site timezone — ISO 8601 like "2026-06-01T00:00:00Z" is ' +
                          'also accepted and auto-converted). Other common keys: "status", or a numeric ' +
                          'Gravity Forms field ID (e.g. "1", "2") to filter on a specific form field\'s value.'
                      },
                      value: {
                        type: 'string',
                        description: 'Value to compare against. For "date_created", use "YYYY-MM-DD HH:MM:SS" ' +
                          '(e.g. "2026-06-01 00:00:00") — ISO 8601 (e.g. "2026-06-01T00:00:00Z") is also ' +
                          'accepted and will be auto-converted.'
                      },
                      operator: {
                        type: 'string',
                        enum: ['=', 'IS', 'CONTAINS', 'IS NOT', 'ISNOT', '<>', 'LIKE', 'NOT IN', 'NOTIN', 'IN', '>', '<', '>=', '<='],
                        description: 'Comparison operator. Use ">=" and "<=" together on "date_created" ' +
                          'to express a date range (with mode "all").'
                      }
                    },
                    additionalProperties: false
                  }
                },
                mode: {
                  type: 'string',
                  enum: ['any', 'all'],
                  description: 'Search mode: "all" = AND all field_filters together (required for a date ' +
                    'range, since it needs both the ">=" and "<=" conditions to hold at once); ' +
                    '"any" = OR them together.'
                }
              },
              additionalProperties: false
            },
            sorting: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                direction: {
                  type: 'string',
                  enum: ['asc', 'desc', 'ASC', 'DESC']
                }
              },
              additionalProperties: false
            },
            paging: {
              type: 'object',
              properties: {
                page_size: { type: 'number' },
                current_page: { type: 'number' }
              },
              additionalProperties: false
            },
            field_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional. Limit each returned entry to only these numeric field IDs (e.g. ["14"] ' +
                'for just the tracking payload field on a form where you already know that field is id 14), ' +
                'plus core entry columns (id, form_id, date_created, date_updated, status). Use this to shrink ' +
                'response size and avoid truncation when a form has many fields or a query returns many entries. ' +
                'Field IDs vary per form — if querying multiple forms or you don\'t already know the ID, use ' +
                '"field_names" instead.'
            },
            field_names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional. Specify field(s) by name instead of numeric ID (matched ' +
                'case-insensitively against each field\'s inputName, adminLabel, or label, in that priority ' +
                'order) — e.g. ["tracking_payload", "phone", "email"]. The matching numeric field ID is looked ' +
                'up automatically per form via the form\'s field configuration, so you don\'t need to call ' +
                'gf_get_form separately first. Unlike "field_ids", each returned entry\'s key is renamed to ' +
                'the semantic name you requested (e.g. entry["tracking_payload"], not entry["14"]) — this ' +
                'holds even when different forms map that name to different numeric IDs, so downstream code ' +
                'can rely on one consistent key across every form. Requires "form_ids" to be set, since ' +
                'resolution happens per form. If a form has no field matching any given name, the response ' +
                'includes that form ID under "unresolved_field_names" instead of silently omitting it.'
            },
            auto_paginate: {
              type: 'boolean',
              description: 'Default true: automatically fetch every matching page (up to a safety cap of 10 ' +
                'pages / 2000 entries) and return the full combined result set in one response, so you don\'t ' +
                'have to manually check total_count and re-request additional pages yourself. Set to false to ' +
                'fetch only a single page, controlled manually via the "paging" parameter.',
              default: true
            },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          },
          additionalProperties: false
        }
      },
      {
        name: 'gf_get_entry',
        description: 'Get an entry by ID with field labels.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Entry ID' },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          },
          additionalProperties: false,
          required: ['id']
        }
      },
      {
        name: 'gf_create_entry',
        description: 'Create an entry',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' },
            created_by: { type: 'number', description: 'Creator user ID' },
            status: {
              type: 'string',
              enum: ['active', 'spam', 'trash'],
              description: 'Entry status'
            },
            date_created: { type: 'string', description: 'ISO date' },
            field_values: {
              type: 'array',
              description: 'Field values for entry, one entry per field',
              items: {
                type: 'object',
                properties: {
                  field_id: { type: 'string', description: 'Gravity Forms field ID (e.g. "1", "2", "1.3")' },
                  value: { type: 'string', description: 'Value for this field' }
                },
                required: ['field_id', 'value'],
                additionalProperties: false
              }
            }
          },
          additionalProperties: false,
          required: ['form_id']
        }
      },
      {
        name: 'gf_update_entry',
        description: 'Update an entry',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Entry ID' },
            status: {
              type: 'string',
              enum: ['active', 'spam', 'trash'],
              description: 'Entry status'
            },
            field_values: {
              type: 'array',
              description: 'Field values to update, one entry per field',
              items: {
                type: 'object',
                properties: {
                  field_id: { type: 'string', description: 'Gravity Forms field ID (e.g. "1", "2", "1.3")' },
                  value: { type: 'string', description: 'Value for this field' }
                },
                required: ['field_id', 'value'],
                additionalProperties: false
              }
            }
          },
          additionalProperties: false,
          required: ['id']
        }
      },
      {
        name: 'gf_delete_entry',
        description: 'Delete an entry (requires ALLOW_DELETE=true)',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Entry ID' },
            force: { type: 'boolean', description: 'Permanent delete (vs trash)' }
          },
          additionalProperties: false,
          required: ['id']
        }
      },
      // Form Submissions (2 tools)
      {
        name: 'gf_submit_form_data',
        description: 'Submit form data (triggers notifications, confirmations, payment)',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' },
            field_values: {
              type: 'array',
              description: 'Field values to submit, one entry per field',
              items: {
                type: 'object',
                properties: {
                  field_id: { type: 'string', description: 'Gravity Forms field ID (e.g. "1", "2", "1.3")' },
                  value: { type: 'string', description: 'Value for this field' }
                },
                required: ['field_id', 'value'],
                additionalProperties: false
              }
            }
          },
          additionalProperties: false,
          required: ['form_id']
        }
      },
      {
        name: 'gf_validate_submission',
        description: 'Validate submission without processing',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' },
            field_values: {
              type: 'array',
              description: 'Field values to validate, one entry per field',
              items: {
                type: 'object',
                properties: {
                  field_id: { type: 'string', description: 'Gravity Forms field ID (e.g. "1", "2", "1.3")' },
                  value: { type: 'string', description: 'Value for this field' }
                },
                required: ['field_id', 'value'],
                additionalProperties: false
              }
            }
          },
          additionalProperties: false,
          required: ['form_id']
        }
      },
      // Notifications (1 tool)
      {
        name: 'gf_send_notifications',
        description: 'Send notifications for entry',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'number', description: 'Entry ID' },
            notification_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Notification IDs to send'
            }
          },
          additionalProperties: false,
          required: ['entry_id']
        }
      },
      // Add-on Feeds (7 tools)
      {
        name: 'gf_list_feeds',
        description: 'List feeds. Filter by form_id and/or addon slug.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            addon: { type: 'string', description: 'Addon slug' },
            form_id: { type: 'number', description: 'Form ID' },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          },
          additionalProperties: false
        }
      },
      {
        name: 'gf_get_feed',
        description: 'Get a feed by ID.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID' },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          },
          additionalProperties: false,
          required: ['id']
        }
      },
      // gf_list_form_feeds removed — gf_list_feeds with form_id does the same thing
      // and also supports addon filtering. Kept listFormFeeds() client method for
      // backwards compatibility but no longer exposed as a tool.
      {
        name: 'gf_create_feed',
        description: 'Create a feed',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            addon_slug: { type: 'string', description: 'Add-on slug' },
            form_id: { type: 'number', description: 'Form ID' },
            is_active: { type: 'boolean', description: 'Feed active state' },
            meta: { type: 'string', description: 'Feed configuration as a JSON-encoded string (e.g. \'{"key":"value"}\'). Must be valid JSON; shape varies by addon_slug.' }
          },
          additionalProperties: false,
          required: ['addon_slug', 'form_id', 'meta']
        }
      },
      {
        name: 'gf_update_feed',
        description: 'Update a feed (full replace)',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID' },
            is_active: { type: 'boolean', description: 'Feed active state' },
            meta: { type: 'string', description: 'Feed configuration as a JSON-encoded string (e.g. \'{"key":"value"}\'). Must be valid JSON; shape varies by addon_slug.' }
          },
          additionalProperties: false,
          required: ['id']
        }
      },
      {
        name: 'gf_patch_feed',
        description: 'Patch a feed (partial update)',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID' },
            is_active: { type: 'boolean', description: 'Feed active state' },
            meta: { type: 'string', description: 'Feed configuration as a JSON-encoded string (e.g. \'{"key":"value"}\'). Must be valid JSON; shape varies by addon_slug.' }
          },
          additionalProperties: false,
          required: ['id']
        }
      },
      {
        name: 'gf_delete_feed',
        description: 'Delete a feed (requires ALLOW_DELETE=true)',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID' }
          },
          additionalProperties: false,
          required: ['id']
        }
      },
      // Field Filters (1 tool)
      {
        name: 'gf_get_field_filters',
        description: 'Get field filters for form',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' }
          },
          additionalProperties: false,
          required: ['form_id']
        }
      },
      // Results (1 tool)
      {
        name: 'gf_get_results',
        description: 'Get quiz/poll/survey results',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' }
          },
          additionalProperties: false,
          required: ['form_id']
        }
      },
      // Field Operations (4 tools) - Intelligent field management
      ...fieldOperationTools
    ]
  };
});
// =================================
// TOOL HANDLERS
// =================================
// Forms Management Handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: params } = request.params;
  // Ensure client is initialized
  if (!gravityFormsClient) {
    await initializeClient();
  }
  // Route to appropriate handler
  // The client already validates internally, just pass params directly
  switch (name) {
    // Forms Management
    case 'gf_list_forms':
      return wrapHandler(() => gravityFormsClient.listForms(params), params)();
    case 'gf_get_form':
      return wrapHandler(() => gravityFormsClient.getForm(params), params)();
    case 'gf_create_form':
      return wrapHandler(() => gravityFormsClient.createForm(params), params)();
    case 'gf_update_form':
      return wrapHandler(() => gravityFormsClient.updateForm(params), params)();
    case 'gf_delete_form':
      return wrapHandler(() => gravityFormsClient.deleteForm(params), params)();
    case 'gf_validate_form': {
      const validateFormParams = {
        form_id: params.form_id,
        ...fieldValuesToObject(params.field_values)
      };
      return wrapHandler(() => gravityFormsClient.validateForm(validateFormParams), validateFormParams)();
    }
    // Entries Management
    case 'gf_list_entries':
      return wrapHandler(async () => {
        // Normalize date_created filter values (tolerates ISO 8601 input,
        // e.g. "2026-06-01T00:00:00Z", converting to the format Gravity
        // Forms' search API actually expects: "2026-06-01 00:00:00").
        const normalizedParams = params.search
          ? { ...params, search: normalizeSearchDateFilters(params.search) }
          : params;

        // Resolve field_names -> field_ids, per form, before querying entries.
        // Also build a rename map (numeric ID -> semantic name) so the
        // response can use the requested name as the key instead of leaving
        // it as a numeric field ID.
        let effectiveFieldIds = Array.isArray(normalizedParams.field_ids) ? [...normalizedParams.field_ids] : [];
        const idToName = {};
        const unresolvedFieldNames = [];
        if (Array.isArray(normalizedParams.field_names) && normalizedParams.field_names.length > 0) {
          if (!Array.isArray(normalizedParams.form_ids) || normalizedParams.form_ids.length === 0) {
            throw new Error("'field_names' requires 'form_ids' to be set, since field IDs are looked up per form.");
          }
          for (const formId of normalizedParams.form_ids) {
            const formResult = await gravityFormsClient.getForm({ id: formId });
            const formFields = extractFormFields(formResult);
            const resolvedPairs = resolveFieldIdsByName(formFields, normalizedParams.field_names);
            if (resolvedPairs.length === 0) {
              unresolvedFieldNames.push(formId);
            }
            for (const pair of resolvedPairs) {
              effectiveFieldIds.push(pair.id);
              idToName[pair.id] = pair.name;
            }
          }
          effectiveFieldIds = [...new Set(effectiveFieldIds)];
        }

        // Fetch entries, auto-paginating by default so the caller gets the
        // complete result set (up to a safety cap) in one response instead
        // of having to manually detect total_count mismatches and re-page.
        const autoPaginate = normalizedParams.auto_paginate !== false;
        const AUTO_PAGE_SIZE = 200;
        const MAX_AUTO_PAGES = 10;

        let allEntries = [];
        let totalCount = 0;
        let pagesFetched = 0;

        if (autoPaginate) {
          let currentPage = 1;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const pageParams = {
              ...normalizedParams,
              paging: { page_size: AUTO_PAGE_SIZE, current_page: currentPage }
            };
            const pageResult = await gravityFormsClient.listEntries(pageParams);
            const pageOutput = normalizedParams.compact !== false ? stripEntryMetaFromResponse(pageResult) : pageResult;
            const pageEntries = Array.isArray(pageOutput.entries) ? pageOutput.entries : [];
            if (typeof pageOutput.total_count === 'number') {
              totalCount = pageOutput.total_count;
            }
            allEntries.push(...pageEntries);
            pagesFetched += 1;
            const noMorePages = pageEntries.length < AUTO_PAGE_SIZE || allEntries.length >= totalCount;
            if (noMorePages || pagesFetched >= MAX_AUTO_PAGES) {
              break;
            }
            currentPage += 1;
          }
        } else {
          const result = await gravityFormsClient.listEntries(normalizedParams);
          const output = normalizedParams.compact !== false ? stripEntryMetaFromResponse(result) : result;
          allEntries = Array.isArray(output.entries) ? output.entries : [];
          totalCount = typeof output.total_count === 'number' ? output.total_count : allEntries.length;
          pagesFetched = 1;
        }

        const isComplete = allEntries.length >= totalCount;

        if (effectiveFieldIds.length > 0) {
          allEntries = filterEntryFields(allEntries, effectiveFieldIds, idToName);
        }

        return {
          entries: allEntries,
          total_count: totalCount,
          entries_returned: allEntries.length,
          pages_fetched: pagesFetched,
          is_complete: isComplete,
          ...(!isComplete ? {
            truncation_notice: `Only ${allEntries.length} of ${totalCount} matching entries were returned ` +
              `(safety cap of ${MAX_AUTO_PAGES} pages / ${MAX_AUTO_PAGES * AUTO_PAGE_SIZE} entries reached). ` +
              'Narrow your date range or filters, or issue additional requests with auto_paginate:false and ' +
              'a higher paging.current_page, to retrieve the remainder.'
          } : {}),
          ...(unresolvedFieldNames.length > 0 ? { unresolved_field_names: unresolvedFieldNames } : {})
        };
      }, params)();
    case 'gf_get_entry':
      return wrapHandler(async () => {
        const result = await gravityFormsClient.getEntry(params);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    case 'gf_create_entry': {
      const createEntryParams = {
        form_id: params.form_id,
        created_by: params.created_by,
        status: params.status,
        date_created: params.date_created,
        ...fieldValuesToObject(params.field_values)
      };
      return wrapHandler(async () => {
        const result = await gravityFormsClient.createEntry(createEntryParams);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    }
    case 'gf_update_entry': {
      const updateEntryParams = {
        id: params.id,
        status: params.status,
        ...fieldValuesToObject(params.field_values)
      };
      return wrapHandler(async () => {
        const result = await gravityFormsClient.updateEntry(updateEntryParams);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    }
    case 'gf_delete_entry':
      return wrapHandler(() => gravityFormsClient.deleteEntry(params), params)();
    // Form Submissions
    case 'gf_submit_form_data': {
      // NOTE: unlike the other field-value tools, submitFormData's original
      // schema declared field_values as a nested object property (not bare
      // additionalProperties passthrough), so field values stay nested here
      // rather than being flattened onto the top-level params object.
      const submitFormParams = {
        form_id: params.form_id,
        field_values: fieldValuesToObject(params.field_values)
      };
      return wrapHandler(() => gravityFormsClient.submitFormData(submitFormParams), submitFormParams)();
    }
    case 'gf_validate_submission': {
      const validateSubmissionParams = {
        form_id: params.form_id,
        ...fieldValuesToObject(params.field_values)
      };
      return wrapHandler(() => gravityFormsClient.validateSubmission(validateSubmissionParams), validateSubmissionParams)();
    }
    // Notifications
    case 'gf_send_notifications':
      return wrapHandler(() => gravityFormsClient.sendNotifications(params), params)();
    // Add-on Feeds
    case 'gf_list_feeds':
      return wrapHandler(() => gravityFormsClient.listFeeds(params), params)();
    case 'gf_get_feed':
      return wrapHandler(() => gravityFormsClient.getFeed(params), params)();
    case 'gf_create_feed': {
      return wrapHandler(async () => {
        const createFeedParams = {
          addon_slug: params.addon_slug,
          form_id: params.form_id,
          is_active: params.is_active,
          meta: parseMetaJson(params.meta)
        };
        return await gravityFormsClient.createFeed(createFeedParams);
      }, params)();
    }
    case 'gf_update_feed': {
      return wrapHandler(async () => {
        const updateFeedParams = {
          id: params.id,
          is_active: params.is_active,
          meta: parseMetaJson(params.meta)
        };
        return await gravityFormsClient.updateFeed(updateFeedParams);
      }, params)();
    }
    case 'gf_patch_feed': {
      return wrapHandler(async () => {
        const patchFeedParams = {
          id: params.id,
          is_active: params.is_active,
          meta: parseMetaJson(params.meta)
        };
        return await gravityFormsClient.patchFeed(patchFeedParams);
      }, params)();
    }
    case 'gf_delete_feed':
      return wrapHandler(() => gravityFormsClient.deleteFeed(params), params)();
    // Utilities
    case 'gf_get_field_filters':
      return wrapHandler(() => gravityFormsClient.getFieldFilters(params), params)();
    case 'gf_get_results':
      return wrapHandler(() => gravityFormsClient.getResults(params), params)();
    // Field Operations - Intelligent field management
    case 'gf_add_field':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_add_field(params, fieldOperations);
      }, params)();
    case 'gf_update_field':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_update_field(params, fieldOperations);
      }, params)();
    case 'gf_delete_field':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_delete_field(params, fieldOperations);
      }, params)();
    case 'gf_list_field_types':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_list_field_types(params, fieldOperations);
      }, params)();
    default:
      return createErrorResponse(`Unknown tool: ${name}`);
  }
});
// =================================
// SERVER INITIALIZATION
// =================================
async function main() {
  try {
    // Initialize client on startup
    await initializeClient();

    // Build an Express app and mount the MCP Streamable HTTP transport on /mcp.
    // Stateless mode (sessionIdGenerator: undefined) creates a fresh transport
    // per request, which is sufficient for a single-tenant tool server and
    // avoids having to track session IDs across requests.
    const app = express();
    app.use(express.json({ limit: '25mb' }));

        function requireMcpToken(req, res, next) {
      const auth = req.headers.authorization || '';
      const provided = auth.toLowerCase().startsWith('bearer ')
        ? auth.slice(7).trim()
        : '';
      const a = Buffer.from(provided);
      const b = Buffer.from(mcpToken);
      if (!provided || a.length !== b.length || !timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      next();
    }
    app.use('/mcp', requireMcpToken);

    app.post('/mcp', async (req, res) => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        });
        res.on('close', () => transport.close());
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error(`MCP request error: ${error.message}`);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null
          });
        }
      }
    });

    // Simple health check for Railway / uptime checks
    app.get('/health', (req, res) => res.status(200).send('ok'));

    const port = process.env.PORT || 8080;
    app.listen(port, '0.0.0.0', () => {
      logger.info(`🚀 GravityKit MCP running on HTTP at http://0.0.0.0:${port}/mcp`);
    });
  } catch (error) {
    logger.error(`Failed to start server: ${error}`);
    process.exit(1);
  }
}
// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('👋 Shutting down GravityKit MCP...');
  process.exit(0);
});
process.on('SIGTERM', async () => {
  logger.info('👋 Shutting down GravityKit MCP...');
  process.exit(0);
});
// Start the server
main().catch((error) => {
  logger.error(`Fatal error: ${error}`);
  process.exit(1);
});
