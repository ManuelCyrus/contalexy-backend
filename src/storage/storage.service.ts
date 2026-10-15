import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { Readable } from 'stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { ApiException } from '../common/errors/api.exception';

export const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};

export interface UploadedFileLike {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

/// Confirma pelo conteúdo (não só pela extensão) que é mesmo uma imagem/PDF.
export function sniffType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  const brand = buffer.subarray(4, 12).toString('ascii');
  if (brand.startsWith('ftyp')) {
    const major = brand.slice(4);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(major)) return 'image/heic';
    if (['mif1', 'msf1'].includes(major)) return 'image/heif';
  }
  return null;
}

/// Pastas cujos ficheiros são públicos (fotos de perfil, logótipos dos bancos).
const PUBLIC_FOLDERS = ['avatars'];
export function isPublicKey(key: string) {
  return PUBLIC_FOLDERS.some((f) => key.startsWith(`${f}/`));
}

/// Guarda ficheiros no disco (UPLOADS_DIR) ou num Space da DigitalOcean / S3
/// (STORAGE_DRIVER=s3). Os recibos NUNCA ficam públicos: no disco leem-se por
/// /files/:id com sessão; no S3 ficam privados e dá-se um endereço temporário.
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;

  get driver(): 'local' | 's3' {
    return env().STORAGE_DRIVER;
  }

  private get root() {
    return resolve(env().UPLOADS_DIR);
  }

  private s3(): S3Client {
    if (!this.client) {
      const e = env();
      if (!e.S3_BUCKET || !e.S3_ACCESS_KEY || !e.S3_SECRET_KEY) throw ApiException.unavailable('STORAGE_NOT_CONFIGURED');
      this.client = new S3Client({
        region: e.S3_REGION,
        endpoint: e.S3_ENDPOINT || undefined,
        forcePathStyle: false,
        credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY },
      });
    }
    return this.client;
  }

  validate(file: UploadedFileLike | undefined, opts: { imagesOnly?: boolean } = {}): string {
    if (!file?.buffer?.length) throw ApiException.badRequest('INVALID_REQUEST');
    const maxMb = env().MAX_UPLOAD_MB;
    if (file.size > maxMb * 1024 * 1024) throw ApiException.badRequest('FILE_TOO_LARGE', { max: maxMb });
    const sniffed = sniffType(file.buffer);
    if (!sniffed || !ALLOWED_TYPES[sniffed]) throw ApiException.badRequest('FILE_TYPE_NOT_ALLOWED');
    if (opts.imagesOnly && !sniffed.startsWith('image/')) throw ApiException.badRequest('FILE_TYPE_NOT_ALLOWED');
    return sniffed;
  }

  async save(file: UploadedFileLike, folder: string, opts: { imagesOnly?: boolean } = {}): Promise<{ key: string; mimeType: string; size: number }> {
    const mimeType = this.validate(file, opts);
    const now = new Date();
    const key = `${folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ALLOWED_TYPES[mimeType]}`;
    if (this.driver === 's3') {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: env().S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: mimeType,
          ContentLength: file.buffer.length,
          // Só as fotos de perfil e os logótipos são públicos; o resto é privado.
          ACL: isPublicKey(key) ? 'public-read' : 'private',
          CacheControl: isPublicKey(key) ? 'public, max-age=604800' : 'private, max-age=0',
        }),
      );
      return { key, mimeType, size: file.size };
    }
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.buffer);
    return { key, mimeType, size: file.size };
  }

  pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    // Nunca sair da pasta dos uploads (../../etc).
    if (!path.startsWith(this.root)) throw ApiException.notFound('FILE_NOT_FOUND');
    return path;
  }

  async exists(key: string): Promise<boolean> {
    if (this.driver === 's3') {
      try {
        await this.s3().send(new HeadObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
        return true;
      } catch {
        return false;
      }
    }
    return existsSync(this.pathFor(key));
  }

  /// O conteúdo (só no disco; no S3 usa-se signedUrl).
  stream(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  /// Lê o ficheiro inteiro (para o reler com a IA, por exemplo).
  async read(key: string): Promise<Buffer> {
    if (this.driver === 's3') {
      const out = await this.s3().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    }
    const chunks: Buffer[] = [];
    for await (const c of this.stream(key)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }

  /// Endereço temporário para um ficheiro privado (só no S3; null no disco).
  async signedUrl(key: string, seconds = env().S3_SIGNED_SECONDS): Promise<{ url: string; expiresAt: Date } | null> {
    if (this.driver !== 's3') return null;
    const url = await getSignedUrl(this.s3(), new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }), { expiresIn: seconds });
    return { url, expiresAt: new Date(Date.now() + seconds * 1000) };
  }

  async remove(key: string) {
    try {
      if (this.driver === 's3') await this.s3().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
      else await unlink(this.pathFor(key));
    } catch (err) {
      // já não existia
      this.logger.debug(`remove ${key}: ${(err as Error).message}`);
    }
  }

  /// Endereço público (só para fotos de perfil e logótipos).
  publicUrl(key: string) {
    const e = env();
    if (this.driver === 's3') {
      const base = (e.S3_PUBLIC_URL || `${e.S3_ENDPOINT.replace('://', `://${e.S3_BUCKET}.`)}`).replace(/\/$/, '');
      return `${base}/${key}`;
    }
    return `${e.APP_PUBLIC_URL.replace(/\/$/, '')}/public/${key}`;
  }
}
