import type {
  Health,
  ProjectDto,
  ProjectInput,
  ProjectUpdate,
  TelegramCheck,
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
};
