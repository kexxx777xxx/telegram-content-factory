import type {
  ActionConfig,
  AiAction,
  ApiKeyDto,
  ApiKeyInput,
  ApiKeyUpdate,
  ChainStepInput,
  DryRunInput,
  DryRunResult,
  Health,
  ModelInfo,
  ProjectDto,
  ProjectInput,
  PostsPage,
  ProjectUpdate,
  ReplenishReportDto,
  TelegramCheck,
  TopicsPage,
} from '@tcf/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Запит не вдався (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

export interface SessionState {
  authenticated: boolean;
  authEnabled: boolean;
}

export interface JobDto {
  id: string;
  type: string;
  projectId: string | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lastError: string | null;
  dedupeKey: string | null;
  updatedAt: string;
}

export interface DashboardData {
  projects: {
    id: string; name: string; slug: string; status: string; timezone: string;
    postsBuffer: number; bufferDepth: number; freshTopics: number; topicsBufferMin: number;
    nextSlotAt: string | null; lastPublishedAt: string | null;
    failedPosts: number; skippedPosts: number;
  }[];
  queue: Record<string, number>;
  deadJobs: { id: string; type: string; lastError: string | null; updatedAt: string }[];
  blocked: { keyLabel: string; model: string; blockedUntil: string }[];
  spendToday: {
    keyLabel: string; requests: number; inputTokens: number; outputTokens: number;
    budget: number | null;
  }[];
  slo: {
    publishedOnTime: number; publishedLate: number; skipped: number;
    fallbackImages: number; totalImages: number;
  };
}

export interface JobsPage {
  counts: Record<string, number>;
  jobs: JobDto[];
}

export interface LaunchResult {
  postId: string;
  job: 'publish_post' | 'generate_and_publish';
  created: boolean;
}

export const api = {
  health: () => request<Health>('/health'),
  session: () => request<SessionState>('/session'),
  login: (password: string) =>
    request<SessionState>('/session', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<SessionState>('/session', { method: 'DELETE' }),

  listProjects: () => request<ProjectDto[]>('/projects'),
  getProject: (id: string) => request<ProjectDto>(`/projects/${id}`),
  createProject: (input: ProjectInput) =>
    request<ProjectDto>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id: string, patch: ProjectUpdate) =>
    request<ProjectDto>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  verifyTelegram: (id: string) =>
    request<TelegramCheck>(`/projects/${id}/verify-telegram`, { method: 'POST' }),

  listKeys: () => request<ApiKeyDto[]>('/keys'),
  createKey: (input: ApiKeyInput) =>
    request<{ id: string }>('/keys', { method: 'POST', body: JSON.stringify(input) }),
  updateKey: (id: string, patch: ApiKeyUpdate) =>
    request<void>(`/keys/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteKey: (id: string) => request<void>(`/keys/${id}`, { method: 'DELETE' }),
  verifyKey: (id: string) =>
    request<{ ok: boolean; modelCount: number; problems: string[] }>(`/keys/${id}/verify`, {
      method: 'POST',
    }),

  listModels: (refresh = false) => request<ModelInfo[]>(`/models${refresh ? '?refresh=true' : ''}`),

  getGenerationConfig: (projectId?: string) =>
    request<ActionConfig[]>(`/config/generation${projectId ? `?projectId=${projectId}` : ''}`),
  saveGenerationConfig: (
    action: AiAction,
    projectId: string | undefined,
    body: { steps?: ChainStepInput[]; promptBody?: string; apiKeyId?: string | null },
  ) =>
    request<ActionConfig[]>(
      `/config/generation/${action}${projectId ? `?projectId=${projectId}` : ''}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  clearGenerationOverride: (
    action: AiAction,
    projectId: string,
    what: { chain?: boolean; prompt?: boolean },
  ) =>
    request<ActionConfig[]>(
      `/config/generation/${action}?projectId=${projectId}&chain=${what.chain !== false}&prompt=${what.prompt !== false}`,
      { method: 'DELETE' },
    ),

  dashboard: () => request<DashboardData>('/dashboard'),
  listJobs: () => request<JobsPage>('/jobs'),
  retryJob: (id: string) => request<void>(`/jobs/${id}/retry`, { method: 'POST' }),
  forcePlan: () =>
    request<{ projects: number; postsPlanned: number; jobsEnqueued: number; skipped: boolean }>(
      '/scheduler/plan',
      { method: 'POST' },
    ),

  listPosts: (projectId: string) => request<PostsPage>(`/projects/${projectId}/posts`),
  updatePost: (postId: string, textHtml: string) =>
    request<unknown>(`/posts/${postId}`, { method: 'PATCH', body: JSON.stringify({ textHtml }) }),
  publishPostNow: (postId: string) =>
    request<LaunchResult>(`/posts/${postId}/publish`, { method: 'POST' }),
  publishProjectNow: (projectId: string) =>
    request<LaunchResult>(`/projects/${projectId}/publish-now`, { method: 'POST' }),
  regeneratePost: (postId: string, keepTopic: boolean) =>
    request<unknown>(`/posts/${postId}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ keepTopic }),
    }),

  listTopics: (projectId: string) => request<TopicsPage>(`/projects/${projectId}/topics`),
  importTopics: (projectId: string, text: string) =>
    request<{ inserted: number; duplicates: number; titles: string[] }>(
      `/projects/${projectId}/topics/import`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),
  replenishTopics: (projectId: string, count: number) =>
    request<ReplenishReportDto>(`/projects/${projectId}/topics/replenish`, {
      method: 'POST',
      body: JSON.stringify({ count }),
    }),
  deleteTopics: (ids: string[]) =>
    request<{ removed: number }>('/topics/delete', { method: 'POST', body: JSON.stringify({ ids }) }),

  dryRun: (projectId: string, input: DryRunInput) =>
    request<DryRunResult>(`/projects/${projectId}/dry-run`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
