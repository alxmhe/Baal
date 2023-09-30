import { ethers } from 'hardhat'
import { MetaTransaction } from '@gnosis.pm/safe-contracts'
import { MultiSend } from './types'


const encodeMetaTransaction = (tx: MetaTransaction): string => {
  const data = ethers.getBytes(tx.data)
  const encoded = ethers.solidityPacked(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [tx.operation, tx.to, tx.value, data.length, data]
  )
  return encoded.slice(2)
}

export const encodeMultiSend = (txs: MetaTransaction[]): string => {
  return "0x" + txs.map((tx) => encodeMetaTransaction(tx)).join("")
}

export const encodeMultiAction = (multisend: MultiSend, actions: string[], tos: string[], values: string[], operations: number[]) => {
  let metatransactions: MetaTransaction[] = []
  for (let index = 0; index < actions.length; index++) {
    metatransactions.push({
      to: tos[index],
      value: values[index],
      data: actions[index],
      operation: operations[index],
    })
  }
  const encodedMetatransactions = encodeMultiSend(
    metatransactions.map((tx) =>({
      ...tx,
      value: BigInt(tx.value)
    }))
  )
  const multi_action = multisend.interface.encodeFunctionData('multiSend', [encodedMetatransactions])
  return multi_action
}

export const decodeMultiAction = (multisend: MultiSend, encoded: string) => {
  const OPERATION_TYPE = BigInt(2)
  const ADDRESS = BigInt(40)
  const VALUE = BigInt(64)
  const DATA_LENGTH = BigInt(64)

  const actions = multisend.interface.decodeFunctionResult('multiSend', encoded)
  let transactionsEncoded = (actions[0] as string).slice(2)

  const transactions: MetaTransaction[] = []

  while (transactionsEncoded.length >= OPERATION_TYPE + ADDRESS + VALUE + DATA_LENGTH) {
    const thisTxLengthHex = transactionsEncoded.slice(
      parseInt((OPERATION_TYPE + ADDRESS + VALUE).toString()),
      parseInt((OPERATION_TYPE + ADDRESS + VALUE + DATA_LENGTH).toString())
    )
    const thisTxLength = BigInt('0x' + thisTxLengthHex)
    transactions.push({
      to: '0x' + transactionsEncoded.slice(2, parseInt((OPERATION_TYPE + ADDRESS).toString())),
      value: '0x' + transactionsEncoded.slice(
        parseInt((OPERATION_TYPE + ADDRESS).toString()),
        parseInt((OPERATION_TYPE + ADDRESS + VALUE).toString())
      ),
      data:
        '0x' +
        transactionsEncoded.slice(
          parseInt((OPERATION_TYPE + ADDRESS + VALUE + DATA_LENGTH).toString()),
          parseInt((
            OPERATION_TYPE + ADDRESS + VALUE + DATA_LENGTH + thisTxLength * BigInt(2)
          ).toString()),
        ),
      operation: parseInt(transactionsEncoded.slice(0, 2)),
    })
    transactionsEncoded = transactionsEncoded.slice(
      parseInt((
        OPERATION_TYPE + ADDRESS + VALUE + DATA_LENGTH + thisTxLength * BigInt(2)
      ).toString()),
    )
  }

  return transactions
}

export const hashOperation = (transactions: string): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder()

  const encoded = abiCoder.encode(['bytes'], [transactions])

  const hashed = ethers.keccak256(encoded)

  return hashed
}
