import { getFxMarketSchedule } from '@irexpro/types/market-schedule';
import AiTradingClient from './AiTradingClient';

export const dynamic = 'force-dynamic';

export default function AiTradingPage() {
  const initialMarketSchedule = getFxMarketSchedule(new Date(), 5);
  return <AiTradingClient initialMarketSchedule={initialMarketSchedule} />;
}
