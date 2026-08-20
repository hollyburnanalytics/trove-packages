/**
 * Shared GraphQL response types for the CLI. These mirror the relevant slice of
 * `schema.graphql` (the fields the CLI selects in `src/operations.ts`). They are
 * intentionally narrow — the CLI reads only what it formats.
 */

/** A document, as selected by the CLI's read operations. */
export interface Document {
  id: string;
  title: string | null;
  author: string | null;
  url: string | null;
  contentType: string;
  tags: string[];
  wordCount: number | null;
  previewText: string | null;
  indexedAt: string;
  contentDate: string | null;
  source: { id: string; name: string; sourceType: string };
  fullText?: string | null;
  externalId?: string;
  feed?: { id: string; name: string } | null;
  // Where the document is in the pipeline — selected only by `get` (the
  // single-document view), so absent on search/list results.
  //
  // A LIST, not a fixed set of date fields. The five timestamp columns this
  // replaces meant the CLI decided what the pipeline's stages were, and it
  // printed a stale list the moment the server's stage set changed.
  processing?: {
    inFlight: boolean;
    degraded?: boolean;
    stages: {
      stage: string;
      status: string;
      skipReason?: string | null;
      updatedAt?: string | null;
    }[];
  } | null;
  lastProcessedAt?: string | null;
}

/** A single search/discover hit. */
interface SearchResult {
  relevanceScore: number;
  snippet: string;
  document: Document;
}

/** The `SearchResults` payload. */
export interface SearchResults {
  totalMatches: number;
  queryTimeMs: number;
  results: SearchResult[];
}

/** The `DocumentConnection` payload from `documents`. */
export interface DocumentConnection {
  totalCount: number;
  hasMore: boolean;
  nodes: Document[];
}

/** A source summary, as selected by `sources`. */
export interface SourceSummary {
  id: string;
  name: string;
  sourceType: string;
  status: string;
  documentCount: number;
  lastSyncedAt: string | null;
}

/** The `IngestResult` payload. */
export interface IngestResult {
  documentsIndexed: number;
  documentsSkipped: number;
  transcriptionsQueued: number;
  cursor: string | null;
  errors: Array<{ externalId: string; message: string }> | null;
}

/** The `UserStats` payload. */
export interface UserStats {
  totalDocuments: number;
  totalSources: number;
  activeSources: number;
  documentsBySourceType: Array<{ sourceType: string; documentCount: number }>;
  documentsByContentType: Array<{ contentType: string; documentCount: number }>;
  recentSyncRuns: Array<{ id: string; status: string; startedAt: string; documentsSynced: number }>;
}

/** A toolkit deployment record (each toolkit runs as a hosted MCP server), as selected by `mcpServers`. */
export interface Toolkit {
  id: string;
  name: string;
  slug: string;
  status: string;
  visibility: string;
  /** Names of the secrets this toolkit declares; values are never returned. */
  secrets: string[];
  tools: Array<{ name: string; description: string | null }>;
  activeDeployment: { id: string; version: string; status: string } | null;
  deployments: Array<{ id: string; version: string; status: string; createdAt: string }>;
}

/** One deployment of a source package, as returned by `deploySource`. */
export interface SourceDeployment {
  id: string;
  /** The identity the deployment's documents carry (marks them as your own). */
  sourceType: string;
  version: string;
  scriptName: string;
  /** `LIVE`, `BUILDING`, `FAILED` or `SUPERSEDED` — only `LIVE` will ever sync. */
  status: string;
  sizeBytes: number | null;
  /** Why the deployment did not go live, when it did not. */
  error: string | null;
}
