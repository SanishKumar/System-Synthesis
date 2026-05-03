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

export interface ArchNodeData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
  nodeType: ArchNodeType;
  status: 'active' | 'inactive' | 'analyzing';
  metadata: NodeMetadata;
  icon?: string;
}

// --- Edge Types ---

export interface ArchEdgeData extends Record<string, unknown> {
  label?: string;
  protocol?: string;
  animated?: boolean;
}

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

export interface MissingComponent {
  title: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
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
  nodes_updated: (payload: { nodes: SerializedNode[]; edges: SerializedEdge[]; userId: string }) => void;
  cursor_moved: (cursor: CursorPosition) => void;
  user_joined: (user: UserPresence) => void;
  user_left: (userId: string) => void;
  ai_analysis_result: (result: AIAnalysisResult) => void;
  board_access_revoked: (payload: { boardId: string; ownerId: string }) => void;
  error: (message: string) => void;
}

export interface ClientToServerEvents {
  join_board: (boardId: string, userName: string, identityId: string) => void;
  leave_board: (boardId: string) => void;
  update_nodes: (payload: { boardId: string; nodes: SerializedNode[]; edges: SerializedEdge[] }) => void;
  cursor_moved: (payload: { boardId: string; cursor: CursorPosition }) => void;
  request_ai_analysis: (payload: { boardId: string; nodes: SerializedNode[]; edges: SerializedEdge[] }) => void;
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
