/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CatalogBuilder } from '@backstage/plugin-catalog-backend';
import { ScaffolderEntitiesProcessor } from '@backstage/plugin-scaffolder-backend';
import { Router } from 'express';
import { GitLabOrgEntityProvider } from '@backstage/plugin-catalog-backend-module-gitlab';
import { PluginEnvironment } from '../types';
import { Duration } from 'luxon';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  const p = GitLabOrgEntityProvider.fromConfig(env.config, {
    id: 'a',
    target: 'https://gitlab.com/backstage-test-imports', // 'https://gitlab.com/backstage-test-imports/subgroup1',
    logger: env.logger,
    schedule: env.scheduler.createScheduledTaskRunner({
      initialDelay: Duration.fromObject({ seconds: 3 }),
      frequency: Duration.fromObject({ seconds: 1000 }),
      timeout: Duration.fromObject({ seconds: 30 }),
    }),
  });

  const builder = await CatalogBuilder.create(env);
  builder.addProcessor(new ScaffolderEntitiesProcessor());
  builder.addEntityProvider(p);
  const { processingEngine, router } = await builder.build();
  await processingEngine.start();

  return router;
}
