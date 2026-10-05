import { Module } from '@nestjs/common'
import { DatabaseModule } from './infrastructure/database/database.module.js'
import { AuthModule } from './modules/auth/auth.module.js'
import { VenueModule } from './modules/venues/venue.module.js'
import { ActivitiesModule } from './modules/activities/activities.module.js'
import { PlatformModule } from './modules/platforms/platform.module.js'
import { HydroModule } from './modules/integrations/hydro/hydro.module.js'
import { ScoringModule } from './modules/scoring/scoring.module.js'
import { ProfilesModule } from './modules/profiles/profiles.module.js'
import { SettingsModule } from './modules/settings/settings.module.js'
import { MembersModule } from './modules/members/members.module.js'
import { FilesModule } from './modules/files/files.module.js'

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    VenueModule,
    ActivitiesModule,
    PlatformModule,
    HydroModule,
    ScoringModule,
    ProfilesModule,
    SettingsModule,
    MembersModule,
    FilesModule,
  ],
})
export class AppModule {}
