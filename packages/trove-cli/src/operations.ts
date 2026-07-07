/**
 * The CLI's pre-written, named GraphQL documents. Each
 * command holds exactly one of these; together they enforce the
 * command→operation mapping. They are a strict subset of
 * the published `schema.graphql` surface — the CLI never exceeds the GraphQL
 * API, it only makes a slice of it ergonomic.
 *
 * The documents are exported as plain strings (rather than codegen output) so
 * the package stays dependency-free; a future step swaps these for the
 * `codegen.ts`-generated typed documents without changing the call sites.
 */

/** Reusable document field selection. */
const DOCUMENT_FIELDS = `
  id
  title
  author
  url
  contentType
  tags
  wordCount
  previewText
  indexedAt
  contentDate
  source { id name sourceType }
`;

/** `query search` — semantic top-K search. */
export const SEARCH = /* GraphQL */ `
  query CliSearch(
    $query: String!
    $sourceId: ID
    $sourceType: String
    $author: String
    $after: DateTime
    $before: DateTime
    $contentType: ContentType
    $tags: [String!]
    $feedId: ID
    $limit: Int
  ) {
    search(
      query: $query
      sourceId: $sourceId
      sourceType: $sourceType
      author: $author
      after: $after
      before: $before
      contentType: $contentType
      tags: $tags
      feedId: $feedId
      limit: $limit
    ) {
      totalMatches
      queryTimeMs
      results {
        relevanceScore
        snippet
        document { ${DOCUMENT_FIELDS} }
      }
    }
  }
`;

/** `query discover` — broad thematic browse. */
export const DISCOVER = /* GraphQL */ `
  query CliDiscover(
    $topic: String!
    $sourceId: ID
    $sourceType: String
    $feedId: ID
    $limit: Int
  ) {
    discover(
      topic: $topic
      sourceId: $sourceId
      sourceType: $sourceType
      feedId: $feedId
      limit: $limit
    ) {
      totalMatches
      queryTimeMs
      results {
        relevanceScore
        snippet
        document { ${DOCUMENT_FIELDS} }
      }
    }
  }
`;

/** `query recent` — chronological by indexedAt. */
export const RECENT = /* GraphQL */ `
  query CliRecent(
    $sourceId: ID
    $sourceType: String
    $author: String
    $since: DateTime
    $feedId: ID
    $limit: Int
  ) {
    recent(
      sourceId: $sourceId
      sourceType: $sourceType
      author: $author
      since: $since
      feedId: $feedId
      limit: $limit
    ) { ${DOCUMENT_FIELDS} }
  }
`;

/** `query document(id)` — a single document with full text. */
export const GET_DOCUMENT = /* GraphQL */ `
  query CliGetDocument($id: ID!) {
    document(id: $id) {
      ${DOCUMENT_FIELDS}
      fullText
      externalId
      feed { id name }
    }
  }
`;

/** `query documents` — the exhaustive lister with totalCount. */
export const LIST_DOCUMENTS = /* GraphQL */ `
  query CliListDocuments(
    $sourceId: ID
    $sourceType: String
    $author: String
    $contentType: ContentType
    $tags: [String!]
    $after: DateTime
    $before: DateTime
    $search: String
    $sortBy: DocumentSortField
    $sortOrder: SortOrder
    $limit: Int
    $offset: Int
  ) {
    documents(
      sourceId: $sourceId
      sourceType: $sourceType
      author: $author
      contentType: $contentType
      tags: $tags
      after: $after
      before: $before
      search: $search
      sortBy: $sortBy
      sortOrder: $sortOrder
      limit: $limit
      offset: $offset
    ) {
      totalCount
      hasMore
      nodes { ${DOCUMENT_FIELDS} }
    }
  }
`;

/** `query sources` — the caller's sources. */
export const SOURCES = /* GraphQL */ `
  query CliSources($sourceType: String, $status: SourceStatus) {
    sources(sourceType: $sourceType, status: $status) {
      id
      name
      sourceType
      status
      documentCount
      lastSyncedAt
    }
  }
`;

/** `query source(id)` — one source with feeds/syncRuns. */
export const SOURCE = /* GraphQL */ `
  query CliSource($id: ID!) {
    source(id: $id) {
      id
      name
      sourceType
      status
      documentCount
      lastSyncedAt
      dateRange { earliest latest }
      topAuthors(limit: 20) { author documentCount }
      feeds { id name externalKey status documentCount lastSyncedAt }
      syncRuns(limit: 5) { id status startedAt completedAt documentsSynced errorMessage }
    }
  }
`;

/** `query stats` — corpus aggregates; also backs `whoami`. */
export const STATS = /* GraphQL */ `
  query CliStats {
    stats {
      totalDocuments
      totalSources
      activeSources
      documentsBySourceType { sourceType documentCount }
      documentsByContentType { contentType documentCount }
      recentSyncRuns(limit: 5) { id status startedAt documentsSynced }
    }
  }
`;

/** `mutation saveDocument` — manual capture. */
export const SAVE_DOCUMENT = /* GraphQL */ `
  mutation CliSaveDocument($input: SaveDocumentInput!) {
    saveDocument(input: $input) {
      id
      title
      url
      tags
      contentType
      source { id name }
    }
  }
`;

/** `mutation ingestDocuments` — the ingest boundary with CAS. */
export const INGEST_DOCUMENTS = /* GraphQL */ `
  mutation CliIngestDocuments(
    $sourceId: ID!
    $feedId: ID!
    $documents: [IngestDocumentInput!]!
    $cursor: String
    $cursorBefore: String
  ) {
    ingestDocuments(
      sourceId: $sourceId
      feedId: $feedId
      documents: $documents
      cursor: $cursor
      cursorBefore: $cursorBefore
    ) {
      documentsIndexed
      documentsSkipped
      transcriptionsQueued
      cursor
      errors { externalId message }
    }
  }
`;

/** `query source(id)` feeds with cursor — backs `source sync`. */
export const SOURCE_FEEDS = /* GraphQL */ `
  query CliSourceFeeds($id: ID!) {
    source(id: $id) {
      id
      name
      feeds { id name externalKey cursor }
    }
  }
`;

/** `mutation createSource` — create the target source for `source sync --create`. */
export const CREATE_SOURCE = /* GraphQL */ `
  mutation CliCreateSource($input: CreateSourceInput!) {
    createSource(input: $input) { id name sourceType }
  }
`;

/** `mutation addFeed` — create the target feed for `source sync --create`. */
export const ADD_FEED = /* GraphQL */ `
  mutation CliAddFeed($sourceId: ID!, $name: String!, $externalKey: String!, $config: JSON) {
    addFeed(sourceId: $sourceId, name: $name, externalKey: $externalKey, config: $config) {
      id
      name
      externalKey
      cursor
    }
  }
`;

/** `query mcpServers` — the user's toolkits (each a hosted MCP server); backs `mcp ls`/`secret ls`. */
export const MCP_SERVERS = /* GraphQL */ `
  query CliMcpServers {
    mcpServers {
      id
      name
      slug
      status
      visibility
      secrets
      tools { name description }
      activeDeployment { id version status sizeBytes createdAt }
      deployments { id version status createdAt }
    }
  }
`;

/** `mutation deployServer` — register/version a toolkit deployment. */
export const DEPLOY_SERVER = /* GraphQL */ `
  mutation CliDeployServer($name: String!, $slug: String!, $manifest: JSON!) {
    deployServer(name: $name, slug: $slug, manifest: $manifest) {
      id
      version
      status
      scriptName
      sizeBytes
      tools { name description }
    }
  }
`;

/** `mutation setServerSecret` — seal a secret into the vault. */
export const SET_SERVER_SECRET = /* GraphQL */ `
  mutation CliSetServerSecret($serverId: ID!, $name: String!, $value: String!) {
    setServerSecret(serverId: $serverId, name: $name, value: $value)
  }
`;

/** `mutation pauseServer` — stop surfacing a toolkit's tools. */
export const PAUSE_SERVER = /* GraphQL */ `
  mutation CliPauseServer($id: ID!) {
    pauseServer(id: $id) { id name status }
  }
`;

/** `mutation resumeServer` — resume a paused toolkit. */
export const RESUME_SERVER = /* GraphQL */ `
  mutation CliResumeServer($id: ID!) {
    resumeServer(id: $id) { id name status }
  }
`;

/** `mutation rollbackServer` — repoint to a prior deployment. */
export const ROLLBACK_SERVER = /* GraphQL */ `
  mutation CliRollbackServer($id: ID!, $deploymentId: ID!) {
    rollbackServer(id: $id, deploymentId: $deploymentId) {
      id
      name
      status
      activeDeployment { id version }
    }
  }
`;

/** `mutation deleteServer` — soft-delete a toolkit. */
export const DELETE_SERVER = /* GraphQL */ `
  mutation CliDeleteServer($id: ID!) {
    deleteServer(id: $id) { id name status }
  }
`;
