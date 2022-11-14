import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { LogLevel, Logger } from "@ethersproject/logger";
import * as dotenv from "dotenv";

// ts-types
import {
  Comptroller,
  SimplePriceOracle,
  WhitePaperInterestRateModel,
  ERC20,
  CErc20Immutable,
  FlashLoan,
} from "../typechain-types/index";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

dotenv.config();

Logger.setLogLevel(LogLevel.ERROR);

const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const UNI_ADDRESS = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const LENDING_POOL_ADDRESSES_PROVIDER_ADDRESS =
  "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5";
const SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const BINANCE_ADDRESS = "0xf977814e90da44bfa03b6295a0616a897441acec"; // 幣安拔拔的地址

const USER1_TOKEN_B_BALANCE = ethers.utils.parseUnits("1000", "18"); // UNI
const USER2_TOKEN_A_BALANCE = ethers.utils.parseUnits("5000", "6"); // USDC's decimals = 6
const USER1_TOKEN_A_BORROW_AMOUNT = ethers.utils.parseUnits("5000", "6");

async function deployFixture() {
  // Contracts are deployed using the first signer/account by default
  const [owner, user0, user1, user2] = await ethers.getSigners();

  // Comptroller
  const ComptrollerContract = await ethers.getContractFactory("Comptroller");
  const comptroller = await ComptrollerContract.deploy();
  await comptroller.deployed();

  // SimplePriceOracle
  const SimplePriceOracleContract = await ethers.getContractFactory(
    "SimplePriceOracle"
  );
  const simplePriceOracle = await SimplePriceOracleContract.deploy();
  await simplePriceOracle.deployed();

  // InterestRateModel, use WhitePaperInterestRateModel here
  const InterestRateModelContract = await ethers.getContractFactory(
    "WhitePaperInterestRateModel"
  );
  const interestRateModel = await InterestRateModelContract.deploy(0, 0);
  await interestRateModel.deployed();

  // tokenA: USDC
  const tokenA = await ethers.getContractAt("ERC20", USDC_ADDRESS);

  // tokenB: UNI
  const tokenB = await ethers.getContractAt("ERC20", UNI_ADDRESS);

  // CTokenA: using USDC as underlying token
  const CTokenAContract = await ethers.getContractFactory("CErc20Immutable");
  const cTokenA = await CTokenAContract.deploy(
    USDC_ADDRESS,
    comptroller.address,
    interestRateModel.address,
    ethers.utils.parseUnits("1", "6"),
    "Compound USD Coin",
    "cUSDC",
    18,
    owner.address
  );
  await cTokenA.deployed();

  // CTokenB: using UNI as underlying token
  const CTokenBContract = await ethers.getContractFactory("CErc20Immutable");
  const cTokenB = await CTokenBContract.deploy(
    UNI_ADDRESS,
    comptroller.address,
    interestRateModel.address,
    ethers.utils.parseUnits("1", "18"),
    "Compound Uniswap",
    "cUNI",
    18,
    owner.address
  );
  await cTokenB.deployed();

  // flash loan contract
  const FlashLoanContract = await ethers.getContractFactory("FlashLoan");
  const flashLoan = await FlashLoanContract.connect(user2).deploy(
    LENDING_POOL_ADDRESSES_PROVIDER_ADDRESS,
    SWAP_ROUTER_ADDRESS
  );
  await flashLoan.deployed();

  return {
    comptroller,
    simplePriceOracle,
    interestRateModel,
    tokenA,
    tokenB,
    cTokenA,
    cTokenB,
    flashLoan,
    owner,
    user0,
    user1,
    user2,
  };
}

describe("compound", function () {
  describe("liquidation", function () {
    let comptroller: Comptroller;
    let simplePriceOracle: SimplePriceOracle;
    let interestRateModel: WhitePaperInterestRateModel;
    let tokenA: ERC20;
    let tokenB: ERC20;
    let cTokenA: CErc20Immutable;
    let cTokenB: CErc20Immutable;
    let flashLoan: FlashLoan;

    let owner: SignerWithAddress;
    let user0: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;

    before(async function () {
      // fork network
      await network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_MAINNET_KEY}`,
              blockNumber: 15815693,
            },
          },
        ],
      });

      // load deployFixture
      ({
        comptroller,
        simplePriceOracle,
        interestRateModel,
        tokenA,
        tokenB,
        cTokenA,
        cTokenB,
        flashLoan,
        owner,
        user0,
        user1,
        user2,
      } = await loadFixture(deployFixture));

      // initial setting

      // set simplePriceOracle as newPriceOracle
      await comptroller._setPriceOracle(simplePriceOracle.address);

      // set USDC = $1
      await simplePriceOracle.setUnderlyingPrice(
        cTokenA.address,
        ethers.utils.parseUnits("1", "30") // because USDC decimal is 6, should multiply (18 - 6)
      );

      // set UNI = $10
      await simplePriceOracle.setUnderlyingPrice(
        cTokenB.address,
        ethers.utils.parseUnits("10", "18")
      );

      // _supportMarket, 把 cToken 新增到 comptroller 的 markets
      await comptroller._supportMarket(cTokenA.address);
      await comptroller._supportMarket(cTokenB.address);

      // _setCollateralFactor, set tokenB's(UNI) collateral factor = 50%
      await comptroller._setCollateralFactor(
        cTokenB.address,
        ethers.utils.parseUnits("0.5", "18")
      );

      // _setCloseFactor, 設定 close factor 最多可以幫被清償人還多少 token
      await comptroller._setCloseFactor(ethers.utils.parseUnits("0.5", "18"));

      // _setLiquidationIncentive, 設定清償人獎勵
      await comptroller._setLiquidationIncentive(
        ethers.utils.parseUnits("1.08", "18")
      );

      // enterMarkets, 為 tokenA tokenB 提供流動性
      await comptroller
        .connect(user1)
        .enterMarkets([cTokenA.address, cTokenB.address]);
      await comptroller
        .connect(user2)
        .enterMarkets([cTokenA.address, cTokenB.address]);

      // send tokens to user1 and user2 from binance
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [BINANCE_ADDRESS],
      });

      const binanceWallet = await ethers.getSigner(BINANCE_ADDRESS);

      await tokenB
        .connect(binanceWallet)
        .transfer(user1.address, USER1_TOKEN_B_BALANCE);
      await tokenA
        .connect(binanceWallet)
        .transfer(user2.address, USER2_TOKEN_A_BALANCE);

      network.provider.request({
        method: "hardhat-stopimpersonatingaccount",
        params: [BINANCE_ADDRESS],
      });

      // user1 mint 1000 cTokenB(cUNI)
      await tokenB
        .connect(user1)
        .approve(cTokenB.address, USER1_TOKEN_B_BALANCE);
      await cTokenB.connect(user1).mint(USER1_TOKEN_B_BALANCE);

      // user2 mint 5000 cTokenA(cUSDC)
      await tokenA
        .connect(user2)
        .approve(cTokenA.address, USER2_TOKEN_A_BALANCE);
      await cTokenA.connect(user2).mint(USER2_TOKEN_A_BALANCE);

      // user1 borrow 5000 TokenA(USDC) with 1 tokenB(UNI) as collateral
      await cTokenA.connect(user1).borrow(USER1_TOKEN_A_BORROW_AMOUNT);
    });

    after(async function () {
      // close fork network
      await network.provider.request({
        method: "hardhat_reset",
        params: []
      });
    })

    it("Should user1 has 1000 cUNI", async function () {
      expect(await cTokenB.balanceOf(user1.address)).to.equal(
        USER1_TOKEN_B_BALANCE
      );
    });

    it("Should user2 has 5000 USDC", async function () {
      expect(await cTokenA.balanceOf(user2.address)).to.equal(
        ethers.utils.parseUnits("5000", "18")
      );
    });

    it("Should user1 borrow 5000 USDC", async function () {
      expect(await tokenA.balanceOf(user1.address)).to.equal(
        USER1_TOKEN_A_BORROW_AMOUNT
      );
    });

    it("Should user1 has shortfall when UNI price drop", async function () {
      await simplePriceOracle.setUnderlyingPrice(
        cTokenB.address,
        ethers.utils.parseUnits("6.2", "18")
      );

      const user1Liquidity = await comptroller.getAccountLiquidity(
        user1.address
      );

      expect(user1Liquidity[0]).to.equal(0); // error
      expect(user1Liquidity[1]).to.equal(0); // liquidity
      expect(user1Liquidity[2]).to.gt(0); // shortfall
    });

    it("Should user2 able to liquidate user1 by flashloan", async function () {
      const abi = ethers.utils.defaultAbiCoder;
      const params = abi.encode(
        ["address", "address", "address", "address"],
        [cTokenA.address, cTokenB.address, user1.address, user2.address]);

      await flashLoan.connect(user2).flashloan(
        USDC_ADDRESS,
        ethers.utils.parseUnits("2500", "6"),
        params
      );
      
      expect(await tokenA.balanceOf(user2.address)).to.gt(ethers.utils.parseUnits("121", "6")) // 121.739940
      expect(await tokenA.balanceOf(user2.address)).to.lt(ethers.utils.parseUnits("122", "6")) // 121.739940
    });
  });
});
