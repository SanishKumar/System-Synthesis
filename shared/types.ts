// ============================================================
// System Synthesis — Shared Types
// ============================================================

// --- Node Types ---

export type ArchNodeType =
  | 'service'
  | 'database'
  | 'gateway'
  | 'queue'
  | 'cache'
  | 'client'
  | 'loadbalancer'
  | 'storage';

export interface NodeMetadata {
  notes: string;
  links: string[];
  codeSnippet: string;
  attachedFiles: AttachedFile[];
}

export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
}

export type ArchTier = 'frontend' | 'backend' | 'data' | 'infrastructure' | 'external';
export type ArchZone = 'public' | 'private' | 'dmz' | 'restricted';
export type ArchEnvironment = 'production' | 'staging' | 'development' | 'shared';

export interface ArchNodeData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
  nodeType: ArchNodeType;
  status: 'active' | 'inactive' | 'analyzing';
  metadata: NodeMetadata;
  icon?: string;
  // Rich domain fields
  tier?: ArchTier;
  zone?: ArchZone;
  tech?: string;
  environment?: ArchEnvironment;
  region?: string;
  instances?: number;
  sla?: string;
}

// --- Edge Types ---

export interface ArchEdgeData extends Record<string, unknown> {
  label?: string;
  protocol?: string;
  animated?: boolean;
  direction?: 'unidirectional' | 'bidirectional';
}

// --- Board Operations (CRDT-ready) ---

export type BoardOperation =
  | { op: 'node_created'; node: SerializedNode }
  | { op: 'node_updated'; nodeId: string; patch: Partial<ArchNodeData> }
  | { op: 'node_moved'; nodeId: string; position: { x: number; y: number } }
  | { op: 'node_deleted'; nodeId: string }
  | { op: 'edge_created'; edge: SerializedEdge }
  | { op: 'edge_updated'; edgeId: string; patch: Partial<ArchEdgeData> }
  | { op: 'edge_deleted'; edgeId: string }
  | { op: 'bulk_sync'; nodes: SerializedNode[]; edges: SerializedEdge[] };

// --- Board State ---

export interface BoardState {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  ownerName: string;
  isPublic: boolean;
  nodes: SerializedNode[];
  edges: SerializedEdge[];
  createdAt: string;
  updatedAt: string;
}

// --- Validation ---

export type ValidationSeverity = 'critical' | 'warning' | 'info';

export interface ValidationIssue {
  id: string;
  severity: ValidationSeverity;
  title: string;
  description: string;
  /** Node IDs involved */
  nodeIds: string[];
  /** Edge IDs involved */
  edgeIds: string[];
  /** Rule identifier for deduplication */
  ruleId: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  timestamp: string;
  stats: {
    critical: number;
    warning: number;
    info: number;
  };
}

export interface SerializedNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: ArchNodeData;
}

export interface SerializedEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  data?: ArchEdgeData;
  animated?: boolean;
}

// --- Multiplayer ---

export interface CursorPosition {
  x: number;
  y: number;
  userId: string;
  userName: string;
  color: string;
}

export interface UserPresence {
  userId: string;
  userName: string;
  color: string;
  connectedAt: string;
}

// --- AI Analysis ---

export interface AIAnalysisResult {
  missingComponents: MissingComponent[];
  suggestedStorage: StorageSuggestion[];
  apiRecommendations: APIRecommendation[];
  scalabilityChecklist: ScalabilityItem[];
  summary?: string;
}

export type AiAction =
  | { type: 'add_node'; nodeType: ArchNodeType; label: string; nearNodeId?: string }
  | { type: 'add_edge'; sourceId: string; targetId: string; label?: string }
  | { type: 'update_node'; nodeId: string; patch: Partial<ArchNodeData> };

/** Result of AI-powered architecture generation */
export interface AIGenerateResult {
  nodes: SerializedNode[];
  edges: SerializedEdge[];
  summary: string;
}

/** Pre-built architecture template */
export interface ArchTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  nodes: SerializedNode[];
  edges: SerializedEdge[];
}

export interface MissingComponent {
  title: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
  actions?: AiAction[];
}

export interface StorageSuggestion {
  name: string;
  type: 'primary' | 'cache' | 'search' | 'queue';
  reason?: string;
}

export interface APIRecommendation {
  name: string;
  description: string;
  badge: string;
}

export interface ScalabilityItem {
  label: string;
  checked: boolean;
  detail?: string;
}

// --- Socket Events ---

export interface ServerToClientEvents {
  board_state: (state: BoardState) => void;
  /** @deprecated Use operation_applied instead */
  nodes_updated: (payload: { nodes: SerializedNode[]; edges: SerializedEdge[]; userId: string }) => void;
  /** New: granular operation broadcast */
  operation_applied: (payload: { operation: BoardOperation; userId: string }) => void;
  cursor_moved: (cursor: CursorPosition) => void;
  user_joined: (user: UserPresence) => void;
  user_left: (userId: string) => void;
  ai_analysis_result: (result: AIAnalysisResult) => void;
  board_access_revoked: (payload: { boardId: string; ownerId: string }) => void;
  error: (message: string) => void;
  yjs_full_state: (stateUpdate: number[] | Uint8Array) => void;
  yjs_update: (payload: { update: number[] | Uint8Array; userId: string }) => void;
}

export interface ClientToServerEvents {
  join_board: (boardId: string, userName: string, identityId: string) => void;
  leave_board: (boardId: string) => void;
  /** @deprecated Use board_operation instead */
  update_nodes: (payload: { boardId: string; nodes: SerializedNode[]; edges: SerializedEdge[] }) => void;
  /** New: emit a single granular operation */
  board_operation: (payload: { boardId: string; operation: BoardOperation }) => void;
  cursor_moved: (payload: { boardId: string; cursor: CursorPosition }) => void;
  request_ai_analysis: (payload: { boardId: string; nodes: SerializedNode[]; edges: SerializedEdge[] }) => void;
  yjs_update: (payload: { boardId: string; update: number[] | Uint8Array }) => void;
}

// --- Dashboard ---

export interface DashboardMetrics {
  totalDiagrams: number;
  activeNodes: number;
  systemUptime: string;
  isLive: boolean;
}

export interface RecentBoard {
  id: string;
  name: string;
  description: string;
  tag: string;
  lastEdited: string;
  collaborators: { name: string; avatar?: string }[];
  thumbnail?: string;
}
