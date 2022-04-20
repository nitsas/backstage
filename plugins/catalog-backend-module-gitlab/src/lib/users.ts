/*
 * Copyright 2021 The Backstage Authors
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

import { UserEntity } from '@backstage/catalog-model';
import { GitLabClient, paginated } from './client';
import { defaultUserTransformer } from './defaultUserTransformer';
import { parseGroupUrl } from './url';
import { GitLabUserResponse, UserTransformer } from './types';

/**
 * Options to configure GitLab user ingestion.
 *
 * @public
 */
export type ReadUsersOptions = {
  inherited?: boolean;
  blocked?: boolean;
  transformer?: UserTransformer;
};

async function transformUsers(
  responses: AsyncGenerator<GitLabUserResponse>,
  transformer: UserTransformer | undefined,
) {
  const result = new Array<UserEntity>();

  for await (const response of responses) {
    const entity = transformer
      ? await transformer({
          user: response,
          defaultTransformer: defaultUserTransformer,
        })
      : defaultUserTransformer(response);
    if (entity) {
      result.push(entity);
    }
  }

  return result;
}

export async function getGroupMembers(
  client: GitLabClient,
  id: string,
  options: ReadUsersOptions = {},
): Promise<UserEntity[]> {
  const endpoint = `/groups/${encodeURIComponent(id)}/members${
    options.inherited ? '/all' : ''
  }`;

  // TODO(minnsoe): perform a second /users/:id request to enrich and match instance users
  const members = paginated<GitLabUserResponse>(
    opts => client.pagedRequest(endpoint, opts),
    { blocked: options.blocked, per_page: 100 },
  );

  return transformUsers(members, options.transformer);
}

export async function getInstanceUsers(
  client: GitLabClient,
  options: ReadUsersOptions = {},
): Promise<UserEntity[]> {
  const users = paginated<GitLabUserResponse>(
    opts => client.pagedRequest('/users', opts),
    { active: true, per_page: 100 },
  );

  return transformUsers(users, options.transformer);
}

/**
 * Read users from a GitLab target and provides User entities.
 */
export async function readUsers(
  client: GitLabClient,
  target: string,
  options: ReadUsersOptions = {},
): Promise<UserEntity[]> {
  const groupFullPath = parseGroupUrl(target, client.baseUrl);
  if (groupFullPath) {
    return getGroupMembers(client, groupFullPath, {
      ...options,
      inherited: options?.inherited ?? true,
    });
  }

  return getInstanceUsers(client, options);
}
