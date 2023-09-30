import { DAOSettings, defaultDAOSettings } from './baal';
import { moveForwardPeriods } from './evm';
import { Baal, TributeMinion } from '../../src/types';

const yes = true;

export type TributeProposalParams = {
    tributeMinion: TributeMinion,
    baal: Baal,
    applicantAddress: string,
    tributeToken: string,
    tribute: bigint,
    requestedShares: bigint,
    requestedLoot: bigint,
    sponsor?: boolean;
    proposalId?: bigint;
    proposalOffering?: bigint;
    proposalExpiration?: bigint;
    proposalBaalGas?: bigint;
    daoSettings?: DAOSettings;
    extraSeconds?: bigint;
};

export type TributeProposalStatus = {
    spentInGas: bigint;
    state: number;
    propStatus: [boolean, boolean, boolean, boolean];
};

export const submitAndProcessTributeProposal = async ({
    tributeMinion,
    baal,
    applicantAddress,
    tributeToken,
    tribute,
    requestedShares,
    requestedLoot,
    sponsor = true,
    proposalId = BigInt(1),
    proposalOffering = BigInt(0),
    proposalExpiration = BigInt(0),
    proposalBaalGas = BigInt(0),
    daoSettings = defaultDAOSettings,
    extraSeconds = BigInt(2),
}: TributeProposalParams): Promise<TributeProposalStatus> => {

    const tx_1 = await tributeMinion.submitTributeProposal(
        await baal.getAddress(),
        tributeToken,
        tribute,
        requestedShares,
        requestedLoot,
        proposalExpiration,
        proposalBaalGas,
        "tribute",
        { value: proposalOffering },
    );
    const tx_2 = sponsor ? await baal.sponsorProposal(proposalId) : undefined;
    const tx_3 = await baal.submitVote(proposalId, yes);
    await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, extraSeconds);

    const encodedProposal = await tributeMinion.encodeTributeProposal(
        await baal.getAddress(),
        requestedShares,
        requestedLoot,
        applicantAddress,
        proposalId,
        await tributeMinion.getAddress(),
    );

    const tx_4 = await baal.processProposal(proposalId, encodedProposal);

    const state = await baal.state(proposalId);
    const propStatus = await baal.getProposalStatus(proposalId);
    
    return {
        spentInGas: (tx_1.gasUsed * tx_1.effectiveGasPrice)
            + (tx_2 ? (tx_2.gasUsed * tx_2.effectiveGasPrice) : BigInt(0))
            + (tx_3.gasUsed * tx_3.effectiveGasPrice)
            + (tx_4.gasUsed * tx_4.effectiveGasPrice),
        state,
        propStatus,
    };
};
