import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { ObjectStorage } from '@knowstudio/storage';
import { OBJECT_STORAGE } from '../shared/tokens.js';

@Controller('local-storage')
export class LocalStorageController {
  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  private send(
    object: { body: Uint8Array; contentType?: string; contentLength?: number },
    response: {
      setHeader: (name: string, value: string) => void;
      send: (value: Buffer) => void;
    },
  ): void {
    response.setHeader(
      'content-type',
      object.contentType ?? 'application/octet-stream',
    );
    response.setHeader('content-length', String(object.contentLength ?? object.body.byteLength));
    response.send(Buffer.from(object.body));
  }

  @Get('videos/:userId/:workId/:variant')
  async video(
    @Param('userId') userId: string,
    @Param('workId') workId: string,
    @Param('variant') variant: string,
    @Res()
    response: {
      setHeader: (name: string, value: string) => void;
      send: (value: Buffer) => void;
    },
  ): Promise<void> {
    const object = await this.storage.getObject(`videos/${userId}/${workId}/${variant}`);
    this.send({ ...object, contentType: 'video/mp4' }, response);
  }

  @Get('layers/:userId/:workId/:kind/:version')
  async layer(
    @Param('userId') userId: string,
    @Param('workId') workId: string,
    @Param('kind') kind: string,
    @Param('version') version: string,
    @Res()
    response: {
      setHeader: (name: string, value: string) => void;
      send: (value: Buffer) => void;
    },
  ): Promise<void> {
    await this.sendObject(`layers/${userId}/${workId}/${kind}/${version}`, response);
  }

  @Get('exports/:userId/:workId/:exportId/:file')
  async export(
    @Param('userId') userId: string,
    @Param('workId') workId: string,
    @Param('exportId') exportId: string,
    @Param('file') file: string,
    @Res()
    response: {
      setHeader: (name: string, value: string) => void;
      send: (value: Buffer) => void;
    },
  ): Promise<void> {
    await this.sendObject(`exports/${userId}/${workId}/${exportId}/${file}`, response);
  }

  private async sendObject(
    key: string,
    response: {
      setHeader: (name: string, value: string) => void;
      send: (value: Buffer) => void;
    },
  ): Promise<void> {
    this.send(await this.storage.getObject(key), response);
  }
}
