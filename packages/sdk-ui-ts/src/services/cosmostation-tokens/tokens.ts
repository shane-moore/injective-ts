import { HttpRestClient } from '@injectivelabs/utils'
import { DenomClient, ChainGrpcBankApi } from '@injectivelabs/sdk-ts'
import { Token, TokenType } from '@injectivelabs/token-metadata'
import { Network, getNetworkEndpoints } from '@injectivelabs/networks'
import fs from 'fs/promises'

const ENDPOINTS = getNetworkEndpoints(Network.Mainnet)
const bankApi = new ChainGrpcBankApi(ENDPOINTS.grpc)
const denomClient = new DenomClient(Network.Mainnet)

const chainListClient = new HttpRestClient('https://raw.githubusercontent.com/')
const ASSETS_JSON_PATH =
  '/shane-moore/chainlist/main/chain/injective/assets.json'

async function fetchExistingAssets() {
  try {
    const response = await chainListClient.get(ASSETS_JSON_PATH)
    return (response as any).data
  } catch (error) {
    console.error(`Error fetching existing assets: ${error}`)
    return [] // Fallback to an empty array if fetching fails
  }
}

async function writeToFile(
  data: any,
  fileName = './src/services/cosmostation-tokens/automated-assets.json',
) {
  await fs.writeFile(fileName, JSON.stringify(data, null, 2))
}

async function fetchSupplyTokenMeta() {
  const { supply } = await bankApi.fetchAllTotalSupply()
  const denoms = supply.map((token) => token?.denom)
  const tokens = denomClient.getDenomsToken(denoms)

  return tokens.filter(
    (token) => token && token?.tokenType !== TokenType.Unknown,
  )
}

function mapType(tokenType: string) {
  const typeMap = {
    [TokenType.Ibc]: 'ibc',
    [TokenType.Erc20]: 'bridge',
  } as { [key: string]: string }

  return typeMap[tokenType] || 'native'
}

function getTokenMetaByTokenType(tokenType: string, token: Token) {
  switch (tokenType) {
    case TokenType.Ibc:
      return {
        enable: true,
        channel: token.ibc?.channelId,
        port: 'transfer',
      }
    case TokenType.Erc20:
      return {
        contract: token.erc20?.address,
      }
    default:
      return {}
  }
}

function getTokenFromManuallyAddedAssets(token: Token, existingAssets: any) {
  return existingAssets.find((asset: any) => {
    if (asset?.denom.toLowerCase() !== token.denom.toLowerCase()) {
      return
    }

    // Check if asset has origin_chain to differentiate manually added or automatically added assets
    return asset.origin_chain
  })
}

function convertTokens(tokens: Token[], existingAssets: any) {
  return tokens.map((token: Token) => {
    console.log({ token })
    const tokenInManuallyAddedAssets = getTokenFromManuallyAddedAssets(
      token,
      existingAssets,
    )

    if (tokenInManuallyAddedAssets) {
      return tokenInManuallyAddedAssets
    }

    const baseValues = {
      denom: token?.denom,
      type: mapType(token.tokenType),
      origin_denom:
        token.tokenType === TokenType.Ibc
          ? token.ibc?.baseDenom
          : token.symbol.toLowerCase(),
      symbol: token.symbol,
      decimals: token.decimals,
      coinGeckoId: token.coinGeckoId,
    }

    const valuesByTokenType = getTokenMetaByTokenType(token.tokenType, token)

    return {
      ...baseValues,
      ...valuesByTokenType,
    }
  })
}

;(async () => {
  try {
    const existingAssets = await fetchExistingAssets()
    const bankTokens = (await fetchSupplyTokenMeta()) as Token[]
    const convertedTokens = convertTokens(bankTokens, existingAssets)

    await writeToFile(convertedTokens)
  } catch (error) {
    console.error(`Error: ${error}`)
  }
})()
