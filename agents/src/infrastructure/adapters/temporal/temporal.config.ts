import type { ConfigService } from '@nestjs/config';

export type TemporalRuntimeConfig = {
  address: string;
  namespace: string;
  taskQueue: string;
  tls: boolean;
  apiKey?: string;
};

export function readTemporalConfig(
  config: ConfigService,
): TemporalRuntimeConfig {
  return {
    address: config.get<string>('TEMPORAL_ADDRESS') ?? '127.0.0.1:7233',
    namespace: config.get<string>('TEMPORAL_NAMESPACE') ?? 'default',
    taskQueue: config.get<string>('TEMPORAL_TASK_QUEUE') ?? 'ens-drop',
    tls: config.get<string>('TEMPORAL_TLS') === 'true',
    apiKey: config.get<string>('TEMPORAL_API_KEY') || undefined,
  };
}
