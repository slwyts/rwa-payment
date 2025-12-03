import { createWalletClient, createPublicClient, http, parseEther, parseAbi, formatUnits } from 'viem'
import { bsc, bscTestnet, mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

export interface Env {
  DB: KVNamespace;
  API_KEY: string;
  PRIVATE_KEY: string;
  
  CHAIN_ID: string;
  BSC_RPC: string;
  ETH_RPC: string;
  ALX_CONTRACT_ADDRESS: string;
  USDT_CONTRACT_ADDRESS: string;
  PAIR_ADDRESS: string;
  CHAINLINK_ORACLE_ADDRESS: string;
}

const jsonResp = (data: any, status = 200) => 
  new Response(JSON.stringify(data), { 
    status, headers: { 'Content-Type': 'application/json' } 
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const apiKey = request.headers.get('X-API-KEY');
    if (!apiKey || apiKey !== env.API_KEY) {
      return jsonResp({ error: 'Unauthorized: Invalid API Key' }, 401);
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/status') {
      const order = url.searchParams.get('order');
      if (!order) return jsonResp({ error: 'Missing order' }, 400);
      const record = await env.DB.get(order, { type: 'json' });
      return record ? jsonResp(record) : jsonResp({ status: 'not_found' }, 404);
    }

    if (request.method === 'POST' && url.pathname === '/pay') {
      try {
        const body: any = await request.json();
        const { address, rwa_amount, offset, order } = body;

        if (!address || !rwa_amount || !order || offset === undefined) {
          return jsonResp({ error: 'Missing parameters' }, 400);
        }

        const existing = await env.DB.get(order, { type: 'json' });
        if (existing) {
          return jsonResp({ msg: 'Duplicate request', data: existing });
        }

        const targetChain = env.CHAIN_ID === '97' ? bscTestnet : bsc;
        const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
        
        const publicClient = createPublicClient({
          chain: targetChain,
          transport: http(env.BSC_RPC)
        });

        const walletClient = createWalletClient({
          account,
          chain: targetChain,
          transport: http(env.BSC_RPC)
        });

        const ethClient = createPublicClient({
          chain: mainnet,
          transport: http(env.ETH_RPC)
        });

        const pairAbi = parseAbi([
          'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
          'function token0() view returns (address)'
        ]);

        const chainlinkAbi = parseAbi([
          'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
        ]);

        const [reserves, token0, oracleData] = await Promise.all([
          publicClient.readContract({
            address: env.PAIR_ADDRESS as `0x${string}`,
            abi: pairAbi,
            functionName: 'getReserves'
          }),
          publicClient.readContract({
            address: env.PAIR_ADDRESS as `0x${string}`,
            abi: pairAbi,
            functionName: 'token0'
          }),
          ethClient.readContract({
            address: env.CHAINLINK_ORACLE_ADDRESS as `0x${string}`,
            abi: chainlinkAbi,
            functionName: 'latestRoundData'
          })
        ]);

        const [reserve0, reserve1] = reserves;
        const [, answer] = oracleData;
        const cnyToUsdRate = BigInt(answer); 

        let alxReserve = 0n;
        let usdtReserve = 0n;

        if (token0.toLowerCase() === env.ALX_CONTRACT_ADDRESS.toLowerCase()) {
          alxReserve = reserve0;
          usdtReserve = reserve1;
        } else {
          alxReserve = reserve1;
          usdtReserve = reserve0;
        }

        if (alxReserve === 0n) throw new Error('Liquidity pool is empty');

        const rwaAmountBigInt = parseEther(rwa_amount.toString());

        const usdtAmount = (rwaAmountBigInt * cnyToUsdRate) / 100000000n;

        let sendAmount = (usdtAmount * alxReserve) / usdtReserve;

        const offsetPercent = Number(offset);
        const multiplier = BigInt(Math.floor((1 + offsetPercent / 100) * 10000));
        sendAmount = (sendAmount * multiplier) / 10000n;

        const txHash = await walletClient.writeContract({
          address: env.ALX_CONTRACT_ADDRESS as `0x${string}`,
          abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
          functionName: 'transfer',
          args: [address as `0x${string}`, sendAmount]
        });

        const resultData = {
          status: 'success',
          tx_hash: txHash,
          alx_sent: formatUnits(sendAmount, 18),
          rwa_value: rwa_amount,
          timestamp: Date.now()
        };

        await env.DB.put(order, JSON.stringify(resultData));

        return jsonResp({ code: 200, data: resultData });

      } catch (e: any) {
        return jsonResp({ error: e.message, stack: e.stack }, 500);
      }
    }

    return jsonResp({ error: 'Not found' }, 404);
  }
};