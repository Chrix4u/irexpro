import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import {
  AiCounterMirrorReportService,
  projectCounterMirrorReport,
} from './ai-counter-mirror-report.service';

const generatedAt = '2026-11-16T15:40:00.000Z';
const example = {
  artifact: 'irexpro-main-counter-pepperstone-virtual-v1',
  generatedAt,
  modifiesTrading: false,
  executionAuthority: 'NONE',
  daily: {
    '2026-11-16': {
      mainClosed: 10, mainWins: 2, mainLosses: 8,
      actualMainNetUsd: -313.36,
      counterComparable: 10,counterWins: 8,counterLosses: 2,
      virtualCounterMatchedNetUsd: 63.99,pairedNetUsd: -249.37,
      unresolvedCounter: 0,
    },
  },
  paired: [{
    pairId: 'trade-1',
    main: {
      label: 'MAIN',instrument:'AUDUSD',direction:'SELL',lotSize:1.72,
      openedAt:'2026-11-16T15:11:22.000Z',closedAt:'2026-11-16T15:17:52.000Z',
      state:'CLOSED',netUsd:-98.04,openMarkEstimateNetUsd:null,
      secretBrokerToken:'SHOULD_NOT_LEAK',
    },
    counter: {
      label:'COUNTER',instrument:'AUDUSD',direction:'BUY',isBrokerOrder:false,
      executionAuthority:'NONE',state:'MATCHED_HORIZON_VIRTUAL_ESTIMATE',
      matchedHorizonNetUsd:72.24,mirroredBarrierNetUsd:72.24,
      openMarkEstimateNetUsd:null,barrierOutcome:'VIRTUAL_MATCHED_MAIN_CLOSE',
      reason:'SAME_MAIN_EXIT_TIME_WITH_SPREAD_AND_COMMISSION_PROXY',
      hiddenResearchMetadata:'SHOULD_NOT_LEAK',
    },
  }],
};

describe('owner-scoped virtual counter report', () => {
  it('projects separate MAIN actual and COUNTER virtual P&L without exposing raw data', () => {
    const report=projectCounterMirrorReport(example,new Date('2026-11-16T15:42:00.000Z'));
    expect(report.virtualOnly).toBe(true);
    expect(report.executionAuthority).toBe('NONE');
    expect(report.stale).toBe(false);
    expect(report.daily[0]).toMatchObject({
      day:'2026-11-16',mainClosed:10,mainNetUsd:-313.36,
      counterEstimatedNetUsd:63.99,
    });
    expect(report.pairs[0]).toMatchObject({
      instrument:'AUDUSD',main:{direction:'SELL',label:'MAIN',netUsd:-98.04},
      counter:{direction:'BUY',label:'COUNTER',virtualOnly:true,matchedHorizonEstimateUsd:72.24},
    });
    expect(JSON.stringify(report)).not.toContain('SHOULD_NOT_LEAK');
  });

  it('cannot mark a virtual broker order as executed',()=>{
    const altered={...example,paired:[{
      ...example.paired[0],
      counter:{...example.paired[0].counter,isBrokerOrder:true},
    }]};
    const report=projectCounterMirrorReport(altered,new Date('2026-11-16T15:42:00Z'));
    expect(report.pairs).toHaveLength(0);
  });

  it('flags stale observations instead of claiming a live feed',()=>{
    const report=projectCounterMirrorReport(example,new Date('2026-11-16T15:50:00Z'));
    expect(report.stale).toBe(true);
  });

  it('rejects non-research or authority-bearing payloads',()=>{
    expect(()=>projectCounterMirrorReport(
      {...example,modifiesTrading:true},new Date('2026-11-16T15:42:00Z'),
    )).toThrow('COUNTER_REPORT_CONTRACT_MISMATCH');
    expect(()=>projectCounterMirrorReport(
      {...example,executionAuthority:'BROKER_NATIVE'},new Date('2026-11-16T15:42:00Z'),
    )).toThrow('COUNTER_REPORT_CONTRACT_MISMATCH');
  });

  it('refuses to read the private owner report for another user',async()=>{
    const config={get:jest.fn().mockReturnValue('owner-uuid')} as unknown as ConfigService;
    const svc=new AiCounterMirrorReportService(config);
    await expect(svc.getOwnerReport('other-user')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
