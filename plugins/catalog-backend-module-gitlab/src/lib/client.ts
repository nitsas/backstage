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

import { InputError } from '@backstage/errors';
import {
  getGitLabRequestOptions,
  GitLabIntegration,
  ScmIntegrationRegistry,
} from '@backstage/integration';
import { merge } from 'lodash';
import fetch, { RequestInit, Response } from 'node-fetch';
import { Logger } from 'winston';
import {
  GitLabProjectResponse,
  GitLabGroupResponse,
  GitLabUserResponse,
} from './types';
import { parseGroupUrl } from './url';

export type ListOptions = {
  [key: string]: string | number | boolean | undefined;
  group?: string;
  per_page?: number | undefined;
  page?: number | undefined;
};

export type PagedResponse<T> = {
  items: T[];
  nextPage?: number;
};

export class GitLabClient {
  constructor(
    private readonly options: {
      integrations: ScmIntegrationRegistry;
      logger: Logger;
    },
  ) {}

  listProjects(
    targetUrl: string,
    options?: {
      last_activity_after?: string;
    },
  ): AsyncGenerator<GitLabProjectResponse> {
    const integration = this.getIntegration(targetUrl);
    const groupFullPath = parseGroupUrl(targetUrl, integration.config.baseUrl);

    if (groupFullPath) {
      const endpoint = `${
        integration.config.apiBaseUrl
      }/groups/${encodeURIComponent(groupFullPath)}/projects`;

      return paginated<GitLabProjectResponse>(
        o => this.pagedRequest(endpoint, o),
        {
          per_page: 100,
          include_subgroups: true,
          ...(options?.last_activity_after && {
            last_activity_after: options.last_activity_after,
          }),
        },
      );
    }

    return paginated<GitLabProjectResponse>(
      o => this.pagedRequest('/projects', o),
      {
        per_page: 100,
        ...(options?.last_activity_after && {
          last_activity_after: options.last_activity_after,
        }),
      },
    );
  }

  listGroups(targetUrl: string): AsyncGenerator<GitLabGroupResponse> {
    const integration = this.getIntegration(targetUrl);

    return paginated<GitLabGroupResponse>(
      options =>
        this.pagedRequest(`${integration.config.apiBaseUrl}/groups`, options),
      { per_page: 100 },
    );
  }

  listUsers(
    targetUrl: string,
    options?: { inherited?: boolean; blocked?: boolean },
  ): AsyncGenerator<GitLabUserResponse> {
    const integration = this.getIntegration(targetUrl);

    // If it is a group URL, list only the members of that group
    const groupFullPath = parseGroupUrl(targetUrl, integration.config.baseUrl);
    if (groupFullPath) {
      const inherited = options?.inherited ?? true;
      const endpoint = `/groups/${encodeURIComponent(groupFullPath)}/members${
        inherited ? '/all' : ''
      }`;

      // TODO(minnsoe): perform a second /users/:id request to enrich and match instance users
      return paginated<GitLabUserResponse>(
        opts => this.pagedRequest(endpoint, opts),
        { per_page: 100, ...(options?.blocked && { blocked: true }) },
      );
    }

    // Otherwise, list the users of the entire instance
    if (integration.config.host !== 'gitlab.com') {
      throw new Error(
        'Getting all GitLab instance users is only supported for self-managed hosts.',
      );
    }

    return paginated<GitLabUserResponse>(
      opts => this.pagedRequest('/users', opts),
      { active: true, per_page: 100 },
    );
  }

  /**
   * Performs a request against a given paginated GitLab endpoint.
   *
   * This method may be used to perform authenticated REST calls against any
   * paginated GitLab endpoint which uses X-NEXT-PAGE headers. The return value
   * can be be used with the {@link paginated} async-generator function to yield
   * each item from the paged request.
   *
   * @see {@link paginated}
   * @param endpoint - The request endpoint, e.g. /projects.
   * @param options - Request queryString options which may also include page variables.
   */
  async pagedRequest<T = any>(
    endpoint: string,
    options?: ListOptions,
  ): Promise<PagedResponse<T>> {
    const queryString = listOptionsToQueryString(options);
    const response = await this.request(`${endpoint}${queryString}`);
    return response.json().then(items => {
      const nextPage = response.headers.get('x-next-page');

      return {
        items,
        nextPage: nextPage ? Number(nextPage) : null,
      } as PagedResponse<any>;
    });
  }

  /**
   * Performs a request using fetch with pre-configured GitLab options.
   *
   * This method can be used to perform authenticated calls to any GitLab
   * endpoint against the configured GitLab instance. The underlying response is
   * returned from fetch without modification. Request options can be overridden
   * as they are merged to produce the final values; passed in values take
   * precedence.
   *
   * If a request response is not okay, this method will throw an error.
   *
   * @param endpoint - The request endpoint, e.g. /user.
   * @param init - Optional request options which may set or override values.
   */
  async request(endpoint: string, init?: RequestInit): Promise<Response> {
    const request = new URL(`${this.config.apiBaseUrl}${endpoint}`);

    this.logger.debug(`Fetching: ${request.toString()}`);
    const response = await fetch(
      request.toString(),
      merge(getGitLabRequestOptions(this.config), init),
    );

    if (!response.ok) {
      throw new Error(
        `Unexpected response when fetching ${request.toString()}. Expected 200 but got ${
          response.status
        } - ${response.statusText}`,
      );
    }

    return response;
  }

  private getIntegration(url: string): GitLabIntegration {
    const integration = this.options.integrations.gitlab.byUrl(url);
    if (!integration) {
      throw new InputError(
        `No GitLab integration found for URL ${url}, Please add a configuration entry for it under integrations.gitlab.`,
      );
    }
    return integration;
  }
}

/**
 * Converts ListOptions for request pagination to a query string.
 *
 * The ListOptions type contains fields which control offset based pagination
 * used by GitLab's API. This function returns a string which may be appended to
 * absolute or relative URLs. The returned value contains a leading `?` if the
 * resulting query string is non-empty.
 *
 * @params options - The pagination ListOptions to convert.
 */
function listOptionsToQueryString(options?: ListOptions): string {
  const search = new URLSearchParams();
  for (const key in options) {
    if (options[key]) {
      search.append(key, options[key]!.toString());
    }
  }
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * Advances through each page and provides each item from a paginated request.
 *
 * The async generator function yields each item from repeated calls to the
 * provided request function. The generator walks through each available page by
 * setting the page key in the options passed into the request function and
 * making repeated calls until there are no more pages.
 *
 * @see {@link GitLabClient.pagedRequest}
 * @param request - Function which returns a PagedResponse to walk through.
 * @param options - Initial ListOptions for the request function.
 */
export async function* paginated<T = any>(
  request: (options: ListOptions) => Promise<PagedResponse<T>>,
  options: ListOptions,
) {
  let res;
  do {
    res = await request(options);
    options.page = res.nextPage;
    for (const item of res.items) {
      yield item;
    }
  } while (res.nextPage);
}
