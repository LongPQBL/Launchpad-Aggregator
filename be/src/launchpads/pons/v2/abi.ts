import { parseAbi, parseAbiItem } from 'viem';

export const v2LaunchEvent = parseAbiItem('event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)');
export const curveBuyEvent = parseAbiItem('event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)');
export const curveSellEvent = parseAbiItem('event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)');
export const curveBuybackEvent = parseAbiItem('event BuybackLocked(uint256 quoteSpent, uint256 tokensLocked)');
export const launchSweptEvent = parseAbiItem('event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)');
export const poolGraduatedEvent = parseAbiItem('event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)');
export const launchGraduationRescuedEvent = parseAbiItem('event LaunchGraduationRescued(address indexed token, address indexed recipient, uint256 quoteAmount, uint256 tokenAmount)');

export const v2FactoryStateAbi = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
]);
