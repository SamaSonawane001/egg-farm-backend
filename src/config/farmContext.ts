import { AsyncLocalStorage } from 'async_hooks';

export interface RequestFarmContext {
  ownerId: string;
  farmId: string | null;
  farmIds: string[];
}

const storage = new AsyncLocalStorage<RequestFarmContext>();

export function runWithFarmContext<T>(
  context: RequestFarmContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function getFarmContext(): RequestFarmContext | undefined {
  return storage.getStore();
}
