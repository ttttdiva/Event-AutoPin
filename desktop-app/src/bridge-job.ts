import { invoke as tauriInvoke } from "@tauri-apps/api/tauri";

/** Python bridgeへ渡す汎用レスポンス。UIの表示状態は含めない。 */
export type BridgeJobResult<T = Record<string, unknown>> = {
  ok?: boolean;
  bridge?: T;
  stderr?: string;
  stdout?: string;
  [key: string]: unknown;
};

export type BridgeInvoker = <T>(
  command: string,
  payload: Record<string, unknown>,
) => Promise<T>;

export type BridgeJobOptions = {
  pythonExe?: string;
  projectRoot?: string;
  timeoutMs?: number;
  /** 純粋なテストからbridge呼び出しを差し替えるための依存性注入。 */
  invoke?: BridgeInvoker;
};

/**
 * TauriのPython bridgeを実行するだけのクライアント。
 * 結果表示、進捗表示、ログ購読、エラー通知は呼び出し側の責務とする。
 */
export async function invokeBridgeJob<T>(
  job: string,
  payload: Record<string, unknown>,
  options: BridgeJobOptions = {},
): Promise<BridgeJobResult<T>> {
  const bridgeInvoke =
    options.invoke ?? (tauriInvoke as unknown as BridgeInvoker);
  return bridgeInvoke<BridgeJobResult<T>>("run_python_bridge", {
    pythonExe: options.pythonExe ?? "",
    projectRoot: options.projectRoot ?? "",
    timeoutMs: options.timeoutMs ?? 10_800_000,
    job,
    payload,
  });
}
