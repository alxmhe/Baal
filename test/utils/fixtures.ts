import { deployments } from 'hardhat';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { Baal, BaalLessShares, BaalSummoner, GnosisSafe, Loot, MockBaal, MultiSend, Poster, Shares, TestERC20, TributeMinion } from '../../src/types';
import { DAOSettings, NewBaalAddresses, NewBaalParams, ProposalParams, SummonSetup, defaultDAOSettings, defaultSummonSetup, setShamanProposal, setupBaal, submitAndProcessProposal } from './baal';
import { BigNumberish, ContractTransaction } from 'ethers';
import { TributeProposalParams, TributeProposalStatus, submitAndProcessTributeProposal } from './tribute';
import { Contract, Provider } from 'ethers';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

export type Signer = {
    address: string;
    sharesInitial: number;
    lootInitial: number;
    baal?: Baal;
    loot?: Loot;
    shares?: Shares;
    tributeMinion?: TributeMinion;
    weth?: TestERC20;
    dai?: TestERC20;
  };

export type ProposalHelpers = {
    submitAndProcessProposal: (params: Omit<ProposalParams, "daoSettings">) => Promise<ContractTransaction>,
    submitAndProcessTributeProposal: (params: Omit<TributeProposalParams, "daoSettings">) => Promise<TributeProposalStatus>,
    setShamanProposal: (baal: Baal, multisend: MultiSend, shamanAddress: string, permission: BigNumberish) => Promise<number>,
};

export type BaalSetupType = {
    Loot: Loot;
    Shares: Shares;
    Baal: Baal;
    BaalSummoner: BaalSummoner;
    GnosisSafe: GnosisSafe;
    MultiSend: MultiSend;
    Poster?: Poster;
    TributeMinion: TributeMinion;
    WETH: TestERC20;
    DAI: TestERC20;
    signers: {
        [key: string]: Signer;
    };
    daoSettings: DAOSettings;
    helpers: ProposalHelpers;
}

type MockBaalSetupType = {
    Loot: Loot;
    LootSingleton: Loot;
    MockBaal: MockBaal;
    signers: {
        [key: string]: Signer;
    };
}

type MockBaalLessTokenSetupType = {
    BaalLessShares: BaalLessShares;
}

export type SetupUsersParams = {
    addresses: NewBaalAddresses;
    baal: Baal;
    hre: HardhatRuntimeEnvironment;
};

export type UsersSetup = {
    dai: TestERC20;
    weth: TestERC20;
    signers: { [key: string]: Signer };
}

type BaalSetupOpts = {
    fixtureTags?: Array<string>;
    daoSettings?: Partial<DAOSettings>;
    summonSetupOpts?: Partial<SummonSetup>;
    safeAddress?: `0x${string}`;
    forwarderAddress?: `0x${string}`;
    lootAddress?: `0x${string}`;
    sharesAddress?: `0x${string}`;
    setupBaalOverride?: (params: NewBaalParams) => Promise<NewBaalAddresses>;
    setupUsersOverride?: (params: SetupUsersParams) => Promise<UsersSetup>;
}

export const setupUsersDefault = async ({
    // addresses,
    baal,
    hre,
}: SetupUsersParams) => {
    const { ethers, deployments, getNamedAccounts, getUnnamedAccounts } = hre;
    const [summoner, applicant, shaman, s1, s2, s3, s4, s5, s6] = await getUnnamedAccounts();

    // @ts-expect-error
    const deployer = (await ethers.getSigners())[0];

    const tributeMinionDeployed = await deployments.get('TributeMinion');
    const tributeMinion = (await ethers.getContractAt('TributeMinion', tributeMinionDeployed.address)) as TributeMinion;

    const lootTokenAddress = await baal.lootToken();
    const lootToken = (await ethers.getContractAt('Loot', lootTokenAddress)) as Loot;

    const sharesTokenAddress = await baal.sharesToken();
    const sharesToken = (await ethers.getContractAt('Shares', sharesTokenAddress)) as Shares;


    const wethDeployed = await deployments.deploy('TestERC20', {
        from: deployer.address,
        args: ['WETH', 'WETH', ethers.parseUnits('10000000', 'ether')]
    });

    const daiDeployed = await deployments.deploy('TestERC20', {
        from: deployer.address,
        args: ['DAI', 'DAI', ethers.parseUnits('10000000', 'ether')]
    });

    const weth = (await ethers.getContractAt('TestERC20', wethDeployed.address)) as TestERC20;
    await weth.transfer(summoner, 1000);
    await weth.transfer(applicant, 1000);

    const dai = (await ethers.getContractAt('TestERC20', daiDeployed.address)) as TestERC20;
    await dai.transfer(summoner, ethers.parseUnits('10', 'ether'));
    await dai.transfer(applicant, ethers.parseUnits('10', 'ether'));
    await dai.transfer(s1, ethers.parseUnits('10', 'ether'));
    await dai.transfer(s2, ethers.parseUnits('10', 'ether'));

    return {
        weth,
        dai,
        signers: {
            summoner: {
                address: summoner,
                baal: baal,
                loot: await ethers.getContractAt('Loot', lootTokenAddress, await ethers.getSigner(summoner)),
                lootInitial: (await lootToken.balanceOf(summoner)).toString(),
                shares: await ethers.getContractAt('Shares', sharesTokenAddress, await ethers.getSigner(summoner)),
                sharesInitial: (await sharesToken.balanceOf(summoner)).toString(),
                tributeMinion: await ethers.getContractAt('TributeMinion', tributeMinionDeployed.address, await ethers.getSigner(summoner)),
                weth: await ethers.getContractAt('TestERC20', wethDeployed.address, await ethers.getSigner(summoner)),
                dai: await ethers.getContractAt('TestERC20', daiDeployed.address, await ethers.getSigner(summoner)),
            },
            applicant: {
                address: applicant,
                baal: await ethers.getContractAt('Baal', await baal.getAddress(), await ethers.getSigner(applicant)),
                loot: await ethers.getContractAt('Loot', lootTokenAddress, await ethers.getSigner(applicant)),
                lootInitial: (await lootToken.balanceOf(applicant)).toString(),
                shares: await ethers.getContractAt('Shares', sharesTokenAddress, await ethers.getSigner(applicant)),
                sharesInitial: (await sharesToken.balanceOf(applicant)).toString(),
                tributeMinion: await ethers.getContractAt('TributeMinion', tributeMinionDeployed.address, await ethers.getSigner(applicant)),
                weth: await ethers.getContractAt('TestERC20', wethDeployed.address, await ethers.getSigner(applicant)),
                dai: await ethers.getContractAt('TestERC20', daiDeployed.address, await ethers.getSigner(applicant)),
            },
            shaman: {
                address: shaman,
                baal: await ethers.getContractAt('Baal', await baal.getAddress(), await ethers.getSigner(shaman)),
                loot: await ethers.getContractAt('Loot', lootTokenAddress, await ethers.getSigner(shaman)),
                lootInitial: 0,
                sharesInitial: 0,
                shares: await ethers.getContractAt('Shares', sharesTokenAddress, await ethers.getSigner(shaman)),
            },
            s1: {
                address: s1,
                baal: await ethers.getContractAt('Baal', await baal.getAddress(), await ethers.getSigner(s1)),
                loot: await ethers.getContractAt('Loot', lootTokenAddress, await ethers.getSigner(s1)),
                lootInitial: 0,
                sharesInitial: 0,
                weth: await ethers.getContractAt('TestERC20', wethDeployed.address, await ethers.getSigner(s1)),
                dai: await ethers.getContractAt('TestERC20', daiDeployed.address, await ethers.getSigner(s1)),
            },
            s2: {
                address: s2,
                baal: await ethers.getContractAt('Baal', await baal.getAddress(), await ethers.getSigner(s2)),
                lootInitial: 0,
                sharesInitial: 0,
                weth: await ethers.getContractAt('TestERC20', wethDeployed.address, await ethers.getSigner(s2)),
                dai: await ethers.getContractAt('TestERC20', daiDeployed.address, await ethers.getSigner(s2)),
            },
            s3: {
                address: s3,
                baal: await ethers.getContractAt('Baal', await baal.getAddress(), await ethers.getSigner(s3)),
                lootInitial: 0,
                sharesInitial: 0,
            },
            s4: {
                address: s4,
                baal: await ethers.getContractAt('Baal', await baal.getAddress(), await ethers.getSigner(s4)),
                lootInitial: 0,
                sharesInitial: 0,
            },
            s5: {
                address: s5,
                baal: await ethers.getContractAt('Baal', await baal.getAddress(), await ethers.getSigner(s5)),
                lootInitial: 0,
                sharesInitial: 0,
            },
            s6: {
                address: s6,
                baal: await ethers.getContractAt('Baal', await baal.getAddress(), await ethers.getSigner(s6)),
                lootInitial: 0,
                sharesInitial: 0,
            },
        },
    };
}

export const baalSetup = deployments.createFixture<BaalSetupType, BaalSetupOpts>(
    async (hre: HardhatRuntimeEnvironment, options?: BaalSetupOpts
) => {
    const { ethers, deployments, getNamedAccounts, getUnnamedAccounts } = hre;
    const { deployer } = await getNamedAccounts();
    const [summoner, applicant, shaman] = await getUnnamedAccounts();

    await deployments.fixture(['Infra', 'TributeMinion', 'BaalSummoner', ...(options?.fixtureTags || [])]); // Deployment Tags

    // console.log('deployments', Object.keys(await deployments.all()));

    const loot = options?.summonSetupOpts?.loot || defaultSummonSetup.loot;
    const lootPaused = options?.summonSetupOpts?.lootPaused || defaultSummonSetup.lootPaused;
    const shares = options?.summonSetupOpts?.shares || defaultSummonSetup.shares;
    const sharesPaused = options?.summonSetupOpts?.sharesPaused || defaultSummonSetup.sharesPaused;
    const shamanPermissions = options?.summonSetupOpts?.shamanPermissions || defaultSummonSetup.shamanPermissions;

    const baalSingleton = await ethers.getContractAt('Baal', (await deployments.get('Baal')).address) as Baal;
    const baalSummoner = await ethers.getContractAt('BaalSummoner', (await deployments.get('BaalSummoner')).address) as Contract & BaalSummoner;
    const poster = await ethers.getContractAt('Poster', (await deployments.get('Poster')).address) as Poster;
    const tributeMinion = await ethers.getContractAt('TributeMinion', (await deployments.get('TributeMinion')).address) as TributeMinion;

    const summonerDist = {
        shares: shares * 2,
        loot,
    };
    const applicantDist = { shares, loot };

    const daoSettings = {
        ...defaultDAOSettings,
        ...options?.daoSettings,
    };

    const setupParams: NewBaalParams = {
        baalSummoner,
        baalSingleton,
        poster,
        config: daoSettings,
        adminConfig: [sharesPaused, lootPaused],
        shamans: [[shaman], [shamanPermissions]],
        shares: [
            [summoner, applicant],
            [summonerDist.shares, applicantDist.shares]
        ],
        loots: [
            [summoner, applicant],
            [summonerDist.loot, applicantDist.loot]
        ],
        safeAddress: options?.safeAddress,
        forwarderAddress: options?.forwarderAddress,
        lootAddress: options?.lootAddress,
        sharesAddress: options?.sharesAddress,
    }; 

    const addresses = options?.setupBaalOverride
        ? await options.setupBaalOverride(setupParams)
        : await setupBaal(setupParams); // use default setup
    // console.log('addresses', addresses);
        
    // @ts-expect-error
    const baal = (await ethers.getContractAt('Baal', addresses.baal, await ethers.getSigner(summoner))) as Baal;
    const gnosisSafe = (await ethers.getContractAt('GnosisSafe', addresses.safe)) as GnosisSafe;
    
    const lootTokenAddress = await baal.lootToken();
    const lootToken = (await ethers.getContractAt('Loot', lootTokenAddress)) as Loot;
    
    const sharesTokenAddress = await baal.sharesToken();
    const sharesToken = (await ethers.getContractAt('Shares', sharesTokenAddress)) as Shares;

    const usersSetup = options?.setupUsersOverride
        ? await options.setupUsersOverride({ addresses, baal, hre })
        : await setupUsersDefault({ addresses, baal, hre });

    const {
        dai,
        weth,
        signers,
    } = usersSetup;

    // console.log({
    //     Loot: await lootToken.getAddress(),
    //     Shares: await sharesToken.getAddress(),
    //     // Baal: (await ethers.getContract('Baal', deployer)) as Baal,
    //     Baal: await baal.getAddress(),
    //     BaalSummoner: await baalSummoner.getAddress(),
    //     GnosisSafe: await gnosisSafe.getAddress(),
    //     // Poster: poster,
    //     TributeMinion: await tributeMinion.getAddress(),
    //     WETH: await weth.getAddress(),
    //     DAI: await dai.getAddress(),
    //     signers: Object.keys(signers).map(s => signers[s].address),
    // });

    return {
        daoSettings,
        Loot: lootToken,
        Shares: sharesToken,
        // Baal: (await ethers.getContract('Baal', deployer)) as Baal,
        Baal: baal,
        BaalSummoner: baalSummoner,
        GnosisSafe: gnosisSafe,
        MultiSend: (await ethers.getContractAt('MultiSend', (await deployments.get('MultiSend')).address)) as MultiSend,
        // Poster: poster,
        TributeMinion: tributeMinion,
        WETH: weth,
        DAI: dai,
        signers,
        helpers: {
            setShamanProposal: (baal, multisend, shamanAddress, permission) => {
                return setShamanProposal(baal, multisend, shamanAddress, permission, daoSettings);
            },
            submitAndProcessProposal: (params) => {
                return submitAndProcessProposal({ ...params, daoSettings });
            },
            submitAndProcessTributeProposal(params) {
                return submitAndProcessTributeProposal({ ...params, daoSettings });
            },
        }
    };
}, 'setupBaal');

export const mockBaalSetup = deployments.createFixture<MockBaalSetupType, unknown>(
    async (hre: HardhatRuntimeEnvironment, options?: unknown
) => {
    const { ethers, deployments, getNamedAccounts, getUnnamedAccounts } = hre;
    const { deployer } = await getNamedAccounts();
    const [summoner, , , s1, s2] = await getUnnamedAccounts();

    await deployments.fixture(['Infra', 'BaalSummoner']);

    const lootSingleton = (await ethers.getContractAt('Loot', (await deployments.get('Loot')).address)) as Loot;
    const mockBallDeployed = await deployments.deploy('MockBaal', {
        contract: 'MockBaal',
        from: deployer,
        args: [
            await lootSingleton.getAddress(),
            'NAME',
            'SYMBOL'
        ],
        log: false,
    });

    const mockBaal = await ethers.getContractAt('MockBaal', mockBallDeployed.address) as MockBaal;
    const lootTokenAddress = await mockBaal.lootToken();
    const loot = await ethers.getContractAt('Loot', lootTokenAddress) as Loot;
    await mockBaal.mintLoot(summoner, 500);

    return {
        Loot: loot,
        LootSingleton: lootSingleton,
        MockBaal: mockBaal,
        signers: {
            summoner: {
                address: summoner,
                // @ts-expect-error
                loot: await ethers.getContractAt('Loot', lootTokenAddress, await ethers.getSigner(summoner)),
                lootInitial: 0,
                sharesInitial: 0,
                
            },
            s1: {
                address: s1,
                // @ts-expect-error
                loot: await ethers.getContractAt('Loot', lootTokenAddress, await ethers.getSigner(s1)),
                lootInitial: 0,
                sharesInitial: 0,
            },
            s2: {
                address: s2,
                // @ts-expect-error
                loot: await ethers.getContractAt('Loot', lootTokenAddress, await ethers.getSigner(s2)),
                lootInitial: 0,
                sharesInitial: 0,
            },
        }
    };
}, 'setupMockBaal');

export const mockBaalLessSharesSetup = deployments.createFixture<MockBaalLessTokenSetupType, unknown>(
    async (hre: HardhatRuntimeEnvironment, options?: unknown
) => {
    const { ethers, deployments, getNamedAccounts, getUnnamedAccounts } = hre;
    const { deployer } = await getNamedAccounts();
    const [summoner] = await getUnnamedAccounts();

    // await deployments.fixture(['Infra', 'BaalSummoner']);

    await deployments.deploy('BaalLessShares', {
        contract: 'BaalLessShares',
        from: deployer,
        args: [],
        log: false,
    });

    const baalLessSharesSingleton = (await ethers.getContractAt('BaalLessShares', (await deployments.get('BaalLessShares')).address)) as BaalLessShares;

    return {
        BaalLessShares: baalLessSharesSingleton,
    };
}, 'setupBaalLessShares');
