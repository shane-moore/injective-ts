import { execSync } from 'child_process'
import { HttpRestClient } from '@injectivelabs/utils'
import { DenomClient, ChainGrpcBankApi } from '@injectivelabs/sdk-ts'
import { Token, TokenType } from '@injectivelabs/token-metadata'
import { Network, getNetworkEndpoints } from '@injectivelabs/networks'
import fsPromises from 'fs/promises'
import fs from 'fs'

type CosmostationToken = {
  denom: string
  type: string
  origin_chain: string
  origin_denom: string
  origin_type: string
  symbol: string
  decimals: 6
  description: string
  image: string
  coinGeckoId: string
}

const ENDPOINTS = getNetworkEndpoints(Network.Mainnet)
const bankApi = new ChainGrpcBankApi(ENDPOINTS.grpc)
const denomClient = new DenomClient(Network.Mainnet)
const chainListClient = new HttpRestClient('https://raw.githubusercontent.com/')
const ASSETS_JSON_PATH =
  '/shane-moore/chainlist/main/chain/injective/assets.json'

const githubToken = process.argv
  .find((arg) => arg.startsWith('--GITHUB_TOKEN='))
  ?.split('=')[1]
if (!githubToken) {
  console.error('Error: GitHub token is required.')
  process.exit(1)
}

async function fetchExistingCosmostationTokens(): Promise<CosmostationToken[]> {
  try {
    const response = (await chainListClient.get(ASSETS_JSON_PATH)) as any

    return response.data as Promise<CosmostationToken[]>
  } catch (error) {
    console.error(`Error fetching existing assets: ${error}`)

    return []
  }
}

async function fetchSupplyTokenMeta() {
  const { supply } = await bankApi.fetchAllTotalSupply()

  const denoms = supply.map((token) => token?.denom)
  const tokens = await denomClient.getDenomsToken(denoms)

  return tokens.filter(
    (token) =>
      token && token?.tokenType !== TokenType.Unknown && token?.coinGeckoId,
  )
}

function getType(tokenType: string) {
  const typeMap = {
    [TokenType.Ibc]: 'ibc',
    [TokenType.Erc20]: 'bridge',
  } as { [key: string]: string }

  return typeMap[tokenType] || 'native'
}

function getOriginChain(token: Token) {
  const typeMap = {
    [TokenType.Ibc]: token.name.toLowerCase(),
    [TokenType.Erc20]: 'ethereum',
    [TokenType.TokenFactory]: 'injective',
    [TokenType.Native]: 'injective',
  } as { [key: string]: string }

  return typeMap[token.tokenType] || ''
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

function tokenExistsInArray(token: Token, array: Token[]) {
  return array.some(
    (asset) => asset.denom.toLowerCase() === token.denom.toLowerCase(),
  )
}

function getOriginDenom(token: Token) {
  switch (token.tokenType) {
    case TokenType.Ibc:
      return token.ibc?.baseDenom
    case TokenType.TokenFactory:
      return token.denom
    default:
      return token.symbol.toLowerCase()
  }
}

function convertToCosmostationTokens(
  tokens: Token[],
  existingCosmostationTokens: any[],
): CosmostationToken[] {
  return tokens.reduce(
    (acc, token) => {
      const tokenExists = tokenExistsInArray(token, acc)

      if (tokenExists) {
        const indexInExisting = acc.findIndex(
          (asset) => asset.denom.toLowerCase() === token.denom.toLowerCase(),
        )

        if (!acc[indexInExisting].coinGeckoId) {
          acc[indexInExisting] = {
            ...acc[indexInExisting],
            coinGeckoId: token.coinGeckoId,
          }
        }

        return acc
      }

      const newToken = {
        denom: token.denom,
        symbol: token.symbol,
        description: token.name,
        decimals: token.decimals,
        coinGeckoId: token.coinGeckoId,
        type: getType(token.tokenType),
        origin_denom: getOriginDenom(token),
        origin_chain: getOriginChain(token),
        ...getTokenMetaByTokenType(token.tokenType, token),
      }

      return [...acc, newToken]
    },
    [...existingCosmostationTokens],
  )
}

async function createPullRequest(branchName: string, githubToken: string) {
  const githubClient = new HttpRestClient('https://api.github.com/')
  githubClient.setConfig({
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  })

  const pullRequestData = {
    title: 'Automate update of assets.json',
    head: branchName,
    base: 'main',
    body: 'This PR updates the assets.json with new token metadata',
  }

  try {
    const response = (await githubClient.post(
      '/repos/shane-moore/chainlist/pulls',
      pullRequestData,
    )) as any
    console.log(`Pull request created: ${response.data.html_url}`)
  } catch (error) {
    console.error(`Error creating pull request: ${error}`)
  }
}

;(async () => {
  try {
    const existingCosmostationTokens = await fetchExistingCosmostationTokens()

    if (existingCosmostationTokens.length === 0) {
      console.log('no assets found in cosmostation assets.json list')
    }

    const bankTokens = (await fetchSupplyTokenMeta()) as Token[]

    const convertedTokens = convertToCosmostationTokens(
      bankTokens,
      existingCosmostationTokens,
    )

    const branchName = `update-assets-${new Date().getTime()}`
    const repoPath = './chainlist'

    /**
     * Check if cosmostation repo exists on your local and remove if so
     */
    if (fs.existsSync(repoPath)) {
      execSync(`rm -rf ${repoPath}`)
    }

    execSync(
      `git clone https://github.com/shane-moore/chainlist.git ${repoPath}`,
    )

    process.chdir(repoPath)
    execSync(`git checkout -b ${branchName}`)
    console.log('New branch created.')

    /** Ensure new metadata are copied over before proceeding */
    await fsPromises.writeFile(
      './chain/injective/assets.json',
      JSON.stringify(convertedTokens, null, 2),
    )

    console.log('assets.json updated.')

    execSync('git add chain/injective/assets.json')
    execSync(`git commit -m "Automated update of assets.json"`)
    execSync(`git push -u origin ${branchName}`)
    console.log('Changes pushed to remote.')

    await createPullRequest(branchName, githubToken)
  } catch (error) {
    console.error(`Error: ${error}`)
  }
})()
