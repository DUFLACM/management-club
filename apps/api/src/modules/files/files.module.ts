import { Module } from '@nestjs/common'
import { UploadController } from './upload.controller.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'

@Module({
  controllers: [UploadController],
  providers: [JobsService],
})
export class FilesModule {}
