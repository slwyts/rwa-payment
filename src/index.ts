import { createWalletClient, createPublicClient, http, parseEther, parseAbi, formatUnits } from 'viem'
import { bsc, bscTestnet, mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

// 1. 定义完整的环境变量接口
export interface Env {
  DB: KVNamespace;
  API_KEY: string;      // 秘密：接口密码
  PRIVATE_KEY: string;  // 秘密：钱包私钥
  
  CHAIN_ID: string;             // 56 or 97
  BSC_RPC: string;              // BSC RPC 节点
  ETH_RPC: string;              // ETH RPC 节点
  ALX_CONTRACT_ADDRESS: string; // ALX 代币地址
  USDT_CONTRACT_ADDRESS: string;// USDT 代币地址
  PAIR_ADDRESS: string;         // PancakeSwap Pair 地址
  CHAINLINK_ORACLE_ADDRESS: string; // Chainlink 预言机地址 (ETH)
}

// 标准响应助手
const jsonResp = (data: any, status = 200) => 
  new Response(JSON.stringify(data), { 
    status, headers: { 'Content-Type': 'application/json' } 
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // === A. 安全校验 ===
    const apiKey = request.headers.get('X-API-KEY');
    if (!apiKey || apiKey !== env.API_KEY) {
      return jsonResp({ error: 'Unauthorized: Invalid API Key' }, 401);
    }

    const url = new URL(request.url);

    // === B. 路由：查询状态 (GET /status?order=xxx) ===
    if (request.method === 'GET' && url.pathname === '/status') {
      const order = url.searchParams.get('order');
      if (!order) return jsonResp({ error: 'Missing order' }, 400);
      const record = await env.DB.get(order, { type: 'json' });
      return record ? jsonResp(record) : jsonResp({ status: 'not_found' }, 404);
    }

    // === C. 路由：发起支付 (POST /pay) ===
    if (request.method === 'POST' && url.pathname === '/pay') {
      try {
        const body: any = await request.json();
        const { address, rwa_amount, offset, order } = body; // rwa_amount 是人民币价值 (1U=7RWA)

        if (!address || !rwa_amount || !order || offset === undefined) {
          return jsonResp({ error: 'Missing parameters' }, 400);
        }

        // 1. 幂等性检查 (防重放)
        const existing = await env.DB.get(order, { type: 'json' });
        if (existing) {
          return jsonResp({ msg: 'Duplicate request', data: existing });
        }

        // 2. 初始化 Viem 客户端
        const targetChain = env.CHAIN_ID === '97' ? bscTestnet : bsc; // 支持测试网切换
        const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
        
        // Public Client 用于读数据 (查价格)
        const publicClient = createPublicClient({
          chain: targetChain,
          transport: http(env.BSC_RPC)
        });

        // Wallet Client 用于写数据 (转账)
        const walletClient = createWalletClient({
          account,
          chain: targetChain,
          transport: http(env.BSC_RPC)
        });

        // 初始化 ETH Client (用于读取 Chainlink)
        const ethClient = createPublicClient({
          chain: mainnet,
          transport: http(env.ETH_RPC)
        });

        // 3. 核心逻辑：从 LP 池获取 ALX 实时价格
        // PancakeSwap Pair ABI (简化版)
        const pairAbi = parseAbi([
          'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
          'function token0() view returns (address)'
        ]);

        // Chainlink ABI
        const chainlinkAbi = parseAbi([
          'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
        ]);

        // 并行查询：获取储备量、token0 地址、以及 ETH 上的 Chainlink 价格
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
        const [, answer] = oracleData; // answer 是 int256，CNY/USD 汇率，8位小数 (如 14000000 表示 0.14)
        const cnyToUsdRate = BigInt(answer); 

        // 判断哪个是 ALX，哪个是 USDT
        // 注意：这里假设 USDT 和 ALX 都是 18 位精度。如果不一样，需要额外处理 decimals
        let alxReserve = 0n;
        let usdtReserve = 0n;

        // 比较地址时全部转小写，防止大小写敏感问题
        if (token0.toLowerCase() === env.ALX_CONTRACT_ADDRESS.toLowerCase()) {
          alxReserve = reserve0;
          usdtReserve = reserve1;
        } else {
          alxReserve = reserve1;
          usdtReserve = reserve0;
        }

        if (alxReserve === 0n) throw new Error('Liquidity pool is empty');

        // 4. 计算汇率与最终转账数量
        // RWA 锚定人民币 (CNY)
        // Chainlink 价格 (cnyToUsdRate) 是 1 CNY 兑换多少 USD (8位小数)
        // 例如 cnyToUsdRate = 14000000 (0.14)
        // 
        // 我们手里有 rwa_amount (CNY)，要换算成 USDT (USD)
        // USDT_Amount = rwa_amount * (cnyToUsdRate / 10^8)
        //
        // 然后再换算成 ALX:
        // ALX_Amount = (USDT_Amount * alxReserve) / usdtReserve
        
        // rwa_amount 假设传进来是普通数字 (如 700)，先转成 18位大整数
        const rwaAmountBigInt = parseEther(rwa_amount.toString());
        
        // 计算 USDT 价值
        // USDT_Amount = (rwaAmountBigInt * cnyToUsdRate) / 10^8
        const usdtAmount = (rwaAmountBigInt * cnyToUsdRate) / 100000000n;

        // 计算理论应发 ALX 数量
        let sendAmount = (usdtAmount * alxReserve) / usdtReserve;
        
        // 应用偏移值 (Offset, 比如 +10.00 表示 +10%)
        // offset 传进来如果是 +10.00 或 -5.00，计算公式为：sendAmount * (1 + offset/100)
        const offsetPercent = Number(offset);
        const multiplier = BigInt(Math.floor((1 + offsetPercent / 100) * 10000));
        sendAmount = (sendAmount * multiplier) / 10000n;

        // 5. 执行链上转账 (ERC20 Transfer)
        // 注意：这里不等待 waitTransactionReceipt，防止超时
        const txHash = await walletClient.writeContract({
          address: env.ALX_CONTRACT_ADDRESS as `0x${string}`,
          abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
          functionName: 'transfer',
          args: [address as `0x${string}`, sendAmount]
        });

        // 6. 记录结果
        const resultData = {
          status: 'success',
          tx_hash: txHash,
          alx_sent: formatUnits(sendAmount, 18), // 记录发了多少个ALX
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