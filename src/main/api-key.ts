/**
 * Guarda a chave da API da AssemblyAI no disco, cifrada.
 *
 * Usamos o `safeStorage` do Electron, que delega para o cofre do sistema
 * (DPAPI no Windows, Keychain no macOS, libsecret no Linux): a chave fica
 * amarrada à conta de usuário do SO, então copiar o arquivo para outra
 * máquina não serve de nada. Um .env ou um JSON em texto puro ficaria legível
 * para qualquer processo do usuário — inaceitável para uma credencial que
 * gera custo por uso.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { ApiKeyStatus } from '../shared/types';

/** Fica em userData: sobrevive à atualização do app, some na desinstalação. */
function keyFilePath(): string {
  return path.join(app.getPath('userData'), 'assemblyai.key');
}

export function saveApiKey(rawKey: string): void {
  const key = rawKey.trim();
  if (!key) {
    clearApiKey();
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'O sistema não disponibilizou o cofre de credenciais, então a chave não ' +
        'pode ser guardada com segurança. Você ainda consegue transcrever ' +
        'colando a chave a cada sessão.'
    );
  }
  fs.mkdirSync(path.dirname(keyFilePath()), { recursive: true });
  fs.writeFileSync(keyFilePath(), safeStorage.encryptString(key));
}

/** Devolve a chave decifrada, ou null se não houver nenhuma guardada. */
export function loadApiKey(): string | null {
  try {
    const encrypted = fs.readFileSync(keyFilePath());
    const key = safeStorage.decryptString(encrypted).trim();
    return key || null;
  } catch {
    // Arquivo ausente, ou cifrado por outra conta de usuário / outra máquina.
    return null;
  }
}

export function clearApiKey(): void {
  fs.rmSync(keyFilePath(), { force: true });
}

/** O que a UI pode saber sobre a chave — nunca a chave inteira. */
export function apiKeyStatus(): ApiKeyStatus {
  const key = loadApiKey();
  if (!key) return { saved: false };
  return { saved: true, hint: key.slice(-4) };
}
