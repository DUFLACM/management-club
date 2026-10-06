import { Module } from '@nestjs/common'
import { UploadController } from './upload.controller.js'

/** 头像处理已内联完成（不再依赖任务队列），worker 的 media.process_avatar 仅作历史任务兜底 */
@Module({
  controllers: [UploadController],
})
export class FilesModule {}
