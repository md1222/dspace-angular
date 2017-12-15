import { Injectable } from '@angular/core';
import { Observable } from 'rxjs/Observable';
import { GlobalConfig } from '../../../config/global-config.interface';
import { hasValue, isNotEmpty, isNotUndefined } from '../../shared/empty.util';
import {
  ErrorResponse, PostPatchSuccessResponse,
  RestResponse
} from '../cache/response-cache.models';
import { ResponseCacheEntry } from '../cache/response-cache.reducer';
import { ResponseCacheService } from '../cache/response-cache.service';
import { HttpPatchRequest, HttpPostRequest, RestRequest } from '../data/request.models';
import { RequestService } from '../data/request.service';
import { HALEndpointService } from '../shared/hal-endpoint.service';
import { CoreState } from '../core.reducers';
import { Store } from '@ngrx/store';
import { jsonPatchOperationsByResourceType } from './selectors';
import { JsonPatchOperationsResourceEntry } from './json-patch-operations.reducer';
import {
  CommitPatchOperationsAction, RollbacktPatchOperationsAction,
  StartTransactionPatchOperationsAction
} from './json-patch-operations.actions';
import { JsonPatchOperationModel } from './json-patch.model';

@Injectable()
export abstract class PostPatchRestService<ResponseDefinitionDomain> extends HALEndpointService {
  protected abstract responseCache: ResponseCacheService;
  protected abstract requestService: RequestService;
  protected abstract linkName: string;
  protected abstract EnvConfig: GlobalConfig;
  protected abstract store: Store<CoreState>;

  protected submitData(request: RestRequest): Observable<ResponseDefinitionDomain> {
    const [successResponse, errorResponse] =  this.responseCache.get(request.href)
      .map((entry: ResponseCacheEntry) => entry.response)
      .partition((response: RestResponse) => response.isSuccessful);
    return Observable.merge(
      errorResponse.flatMap((response: ErrorResponse) =>
        Observable.throw(new Error(`Couldn't send data to server`))),
      successResponse
        .filter((response: PostPatchSuccessResponse) => isNotEmpty(response))
        .map((response: PostPatchSuccessResponse) => response.dataDefinition)
        .distinctUntilChanged());
  }

  protected submitJsonPatchOperations(hrefObs: Observable<string>, resourceType: string, resourceId?: string) {
    return hrefObs
      .flatMap((endpointURL: string) => {
        return this.store.select(jsonPatchOperationsByResourceType(resourceType))
          .take(1)
          .filter((operationsList: JsonPatchOperationsResourceEntry) => isNotEmpty(operationsList))
          .do(() => this.store.dispatch(new StartTransactionPatchOperationsAction(resourceType, resourceId, new Date().getTime())))
          .map((operationsList: JsonPatchOperationsResourceEntry)  => {
            const body: JsonPatchOperationModel[] = [];
            if (isNotEmpty(resourceId)) {
              if (isNotUndefined(operationsList.children[resourceId]) && isNotEmpty(operationsList.children[resourceId].body)) {
                operationsList.children[resourceId].body.forEach((entry) => {
                  body.push(entry.operation);
                });
              }
            } else {
              Object.keys(operationsList.children)
                .filter((key) => operationsList.children.hasOwnProperty(key))
                .filter((key) => hasValue(operationsList.children[key]))
                .filter((key) => hasValue(operationsList.children[key].body))
                .forEach((key) => {
                  operationsList.children[key].body.forEach((entry) => {
                    body.push(entry.operation);
                  });
                })
            }
            return new HttpPatchRequest(endpointURL, body);
          });
      })
      .do((request: HttpPatchRequest) => this.requestService.configure(request, true))
      .flatMap((request: HttpPatchRequest) => {
        const [successResponse, errorResponse] =  this.responseCache.get(request.href)
          .take(1)
          .map((entry: ResponseCacheEntry) => entry.response)
          .partition((response: RestResponse) => response.isSuccessful);
        return Observable.merge(
          errorResponse
            .do(() => this.store.dispatch(new RollbacktPatchOperationsAction(resourceType, resourceId)))
            .flatMap((response: ErrorResponse) => Observable.of(new Error(`Couldn't patch operations`))),
          successResponse
            .filter((response: PostPatchSuccessResponse) => isNotEmpty(response))
            .do(() => this.store.dispatch(new CommitPatchOperationsAction(resourceType, resourceId)))
            .map((response: PostPatchSuccessResponse) => response.dataDefinition)
            .distinctUntilChanged());
      })
  }

  protected getEndpointByIDHref(endpoint, resourceID): string {
    return isNotEmpty(resourceID) ? `${endpoint}/${resourceID}` : `${endpoint}`;
  }

  public postToEndpoint(linkName: string, body: any): Observable<ResponseDefinitionDomain>  {
    return this.getEndpoint(linkName)
      .filter((href: string) => isNotEmpty(href))
      .distinctUntilChanged()
      .map((endpointURL: string) => new HttpPostRequest(endpointURL, body))
      .do((request: HttpPostRequest) => this.requestService.configure(request, true))
      .flatMap((request: HttpPostRequest) => this.submitData(request))
      .distinctUntilChanged();
  }

  public patchToEndpoint(linkName: string, body: any): Observable<ResponseDefinitionDomain>  {
    return this.getEndpoint(linkName)
      .filter((href: string) => isNotEmpty(href))
      .distinctUntilChanged()
      .map((endpointURL: string) => new HttpPostRequest(endpointURL, body))
      .do((request: HttpPostRequest) => this.requestService.configure(request, true))
      .flatMap((request: HttpPostRequest) => this.submitData(request))
      .distinctUntilChanged();
  }

  /*public jsonPatchbyResourceType(resourceType: string) {
    return this.submitJsonPatchOperations(resourceType);
  }*/

  public jsonPatchByResourceType(scopeId:string, resourceType: string, linkName?:string) {
    const hrefObs = this.getEndpoint(linkName)
      .filter((href: string) => isNotEmpty(href))
      .distinctUntilChanged()
      .map((endpointURL: string) => this.getEndpointByIDHref(endpointURL, scopeId));

    return this.submitJsonPatchOperations(hrefObs, resourceType);
  }

  public jsonPatchByResourceID(scopeId:string, resourceType: string, resourceId: string, linkName?:string) {
    const hrefObs = this.getEndpoint(linkName)
      .filter((href: string) => isNotEmpty(href))
      .distinctUntilChanged()
      .map((endpointURL: string) => this.getEndpointByIDHref(endpointURL, scopeId));

    return this.submitJsonPatchOperations(hrefObs, resourceType, resourceId);
  }
}
