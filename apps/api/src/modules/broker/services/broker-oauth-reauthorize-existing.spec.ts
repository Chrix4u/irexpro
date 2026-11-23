import { ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrokerOAuthService } from './broker-oauth.service';
import { CredentialEncryptionService } from './credential-encryption.service';
import { BrokerMode } from '../interfaces/broker-adapter.interface';
import type { BrokerService } from '../broker.service';
import type { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import type { AuditService } from '../../audit/audit.service';
import type { BrokerLinkOutboxService } from './broker-link-outbox.service';
import type { Repository } from 'typeorm';
import type { BrokerOAuthFlow } from '../entities/broker-oauth-flow.entity';
import type { BrokerConnection } from '../entities/broker-connection.entity';

/** No SQLite, provider writes, account IDs or keys from production. */
describe('existing account OAuth reauthorization (pure mocked provider/repository)', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const accountId = '12345678';
  const newToken = 'new-oauth-access-token-test';
  const newRefresh = 'new-oauth-refresh-token-test';
  const configure = () => {
    const encryption = new CredentialEncryptionService(new ConfigService({
      BROKER_ENCRYPTION_KEY: 'test-rotation-encryption-key-exactly-32!',
    }));
    const bundle = encryption.encryptJson({ accessToken: newToken, refreshToken: newRefresh });
    const expiresAt = new Date(Date.now() + 3600_000);
    const flow = {
      id: 'flow-1',userId,brokerId:'pepperstone-ctrader',state:'AUTHORIZED',
      expiresAt,accessTokenExpiresAt:expiresAt,
      tokenCiphertext:bundle.ciphertext,tokenIv:bundle.iv,tokenTag:bundle.tag,
      tokenKeyId:bundle.keyId,
      accounts:[{ctidTraderAccountId:accountId,isLive:true,brokerTitleShort:'Pepperstone'}],
    };
    const existing = {
      id:'connection-1',userId,brokerId:'pepperstone-ctrader',
      accountId,accountType:BrokerMode.LIVE,providerBrokerIdentity:'pepperstone',
      liveTradingEnabled:false,authorizationStatus:'CONNECTED',
    };
    const rotateCredentials = jest.fn().mockResolvedValue(undefined);
    const createConnection = jest.fn();
    const findLiveConnectionByLogicalKey = jest.fn().mockResolvedValue(existing);
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const repo = {
      findOne:jest.fn().mockImplementation(async () => ({...flow,accounts:flow.accounts})),
      createQueryBuilder:jest.fn().mockImplementation(() => {
        let patch:Record<string,unknown> = {};
        let action='';
        return {
          update() {action='update';return this;},
          delete() {action='delete';return this;},
          from() {return this;},
          set(value:Record<string,unknown>) {patch=value;return this;},
          where() {return this;},
          async execute() {
            if(action==='delete')return {affected:0};
            if(patch.state==='LINKING' && flow.state==='AUTHORIZED') {
              flow.state='LINKING';return {affected:1};
            }
            if(patch.state==='CONSUMED' && flow.state==='LINKING') {
              flow.state='CONSUMED'; flow.tokenCiphertext=null as unknown as string;
              return {affected:1};
            }
            return {affected:0};
          },
        };
      }),
    };
    const service=new BrokerOAuthService(
      { rotateCredentials, createConnection, findLiveConnectionByLogicalKey } as unknown as BrokerService,
      {} as CTraderClientService, {} as AuditService, {} as ConfigService,
      encryption,repo as unknown as Repository<BrokerOAuthFlow>,
      {enqueue} as unknown as BrokerLinkOutboxService,
    );
    return {service,flow,existing,rotateCredentials,createConnection,enqueue};
  };

  it('validates/rotates SAME LIVE account with the new OAuth bundle, consumes flow, and preserves the existing trading state',async()=>{
    const f=configure();
    const result=await f.service.linkAccount(userId,'flow-1',accountId);
    expect(result).toBe(f.existing);
    expect(f.rotateCredentials).toHaveBeenCalledTimes(1);
    expect(f.rotateCredentials).toHaveBeenCalledWith('connection-1',expect.objectContaining({
      brokerId:'pepperstone-ctrader',accountType:BrokerMode.LIVE,accountId,
      apiKey:newToken,additionalParams:expect.objectContaining({refreshToken:newRefresh}),
    }),userId,undefined);
    expect(f.createConnection).not.toHaveBeenCalled();
    expect(f.flow.state).toBe('CONSUMED');
    expect(f.flow.tokenCiphertext).toBeNull();
    expect(f.existing.liveTradingEnabled).toBe(false);
    expect(f.existing.authorizationStatus).toBe('CONNECTED');
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('fails closed when provider refuses the newly authorized credentials',async()=>{
    const f=configure();
    f.rotateCredentials.mockRejectedValue(new BadRequestException('Provider rejected OAuth pair'));
    await expect(f.service.linkAccount(userId,'flow-1',accountId)).rejects.toThrow(BadRequestException);
    expect(f.flow.state).toBe('LINKING');
    expect(f.createConnection).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('refuses an identity mismatch before attempting credential rotation',async()=>{
    const f=configure();
    f.existing.accountId='not-the-authorized-account';
    await expect(f.service.linkAccount(userId,'flow-1',accountId)).rejects.toThrow(ConflictException);
    expect(f.rotateCredentials).not.toHaveBeenCalled();
    expect(f.createConnection).not.toHaveBeenCalled();
  });
});
