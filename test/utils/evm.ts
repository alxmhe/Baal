import { mine, time } from "@nomicfoundation/hardhat-network-helpers";

export const blockTime = async () => {
    return time.latest();
};

export const blockNumber = async () => {
    return time.latestBlock();
};

export const moveForwardPeriods = async (
    blockTimeInSecs: number | bigint,
    blocks: number | bigint,
    extra: number | bigint = 1
) => {
    await mine(BigInt(blocks) + BigInt(extra), { interval: BigInt(blockTimeInSecs) });
    return true;
};
