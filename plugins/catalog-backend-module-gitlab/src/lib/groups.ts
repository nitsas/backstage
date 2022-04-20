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

import { GroupEntity, stringifyEntityRef } from '@backstage/catalog-model';
import { GitLabClient } from './client';
import { defaultGroupTransformer } from './defaultGroupTransformer';
import { GitLabSharedGroupResponse } from './types';
import { getGroupMembers } from './users';

export type GroupNode = {
  entity: GroupEntity;
  parent: number | null;
  children: number[];
};

export type GroupAdjacency = Map<number, GroupNode>;

export async function readGroups(
  client: GitLabClient,
  targetUrl: string,
  pathDelimiter: string,
  groupType: string = 'team',
): Promise<GroupAdjacency> {
  const groups = client.listGroups(targetUrl);

  const groupAdjacency = new Map<number, GroupNode>();
  for await (const result of groups) {
    const entity = defaultGroupTransformer(result, {
      pathDelimiter,
      groupType,
    });
    if (entity) {
      if (!groupAdjacency.has(result.id)) {
        groupAdjacency.set(result.id, {
          children: [],
          parent: result.parent_id,
          entity,
        });
      }
    }
  }

  await populateChildrenMembers(client, groupAdjacency);
  mapChildrenToEntityRefs(groupAdjacency);
  return groupAdjacency;
}

export async function populateChildrenMembers(
  client: GitLabClient,
  groupAdjacency: GroupAdjacency,
) {
  // map ids of children using parent for each group node
  for (const [id, { parent, entity }] of groupAdjacency) {
    // append as child of parent if present
    if (parent !== null) {
      const parentGroupNode = groupAdjacency.get(parent);
      if (parentGroupNode) {
        parentGroupNode.children.push(id);
      }
    }
    // populate direct members
    const users = await getGroupMembers(client, String(id), {
      inherited: false,
    });
    for (const user of users) {
      entity.spec!.members!.push(
        stringifyEntityRef({
          kind: 'user',
          name: user.metadata.name,
        }),
      );
    }
    // populate direct members of shared_with_groups
    const sharedWithGroups = await getSharedWithGroupsIDs(client, String(id));
    for (const sharedID of sharedWithGroups) {
      // populate direct members
      const sharedGroupUsers = await getGroupMembers(client, sharedID, {
        inherited: false,
      });
      for (const user of sharedGroupUsers) {
        entity.spec!.members!.push(
          stringifyEntityRef({
            kind: 'user',
            name: user.metadata.name,
          }),
        );
      }
    }
  }
}

async function getSharedWithGroupsIDs(
  client: GitLabClient,
  id: string,
): Promise<string[]> {
  const response = await client.request(`/groups/${encodeURIComponent(id)}`);
  const { shared_with_groups } = await response.json();
  if (shared_with_groups) {
    return shared_with_groups.map((group: GitLabSharedGroupResponse) =>
      String(group.group_id),
    );
  }
  return [];
}

function mapChildrenToEntityRefs(groupAdjacency: GroupAdjacency) {
  // map entity references of children from ids
  for (const [_, { entity, children }] of groupAdjacency) {
    for (const child of children) {
      const childEntity = groupAdjacency.get(child)?.entity;
      if (childEntity) {
        entity.spec!.children!.push(stringifyEntityRef(childEntity));
      }
    }
  }
}
