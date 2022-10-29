import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("compound", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployFixture() {
    const ERC20_INITIAL_SUPPLY = ethers.utils.parseUnits("10000", "18")
    const USER1_INITAL_ERC20_BALANCE = ethers.utils.parseUnits("100", "18")

    // Contracts are deployed using the first signer/account by default
    const [owner, user1, user2, otherAccount] = await ethers.getSigners();

    // Comptroller
    const ComptrollerContract = await ethers.getContractFactory("Comptroller");
    const comptroller = await ComptrollerContract.deploy();
    await comptroller.deployed()

    // SimplePriceOracle
    const SimplePriceOracleContract = await ethers.getContractFactory("SimplePriceOracle");
    const simplePriceOracle = await SimplePriceOracleContract.deploy();
    await simplePriceOracle.deployed()

    // InterestRateModel, use WhitePaperInterestRateModel here
    const InterestRateModelContract = await ethers.getContractFactory("WhitePaperInterestRateModel");
    const interestRateModel = await InterestRateModelContract.deploy(0, 0);
    await interestRateModel.deployed()


    // underlying ERC20 token
    const Erc20Contract = await ethers.getContractFactory("SmartBruceToken");
    const erc20 = await Erc20Contract.deploy(ERC20_INITIAL_SUPPLY);
    await erc20.deployed()

    // CErc20, use CErc20Immutable
    const CErc20Contract = await ethers.getContractFactory("CErc20Immutable");
    const cErc20 = await CErc20Contract.deploy(erc20.address, comptroller.address, interestRateModel.address, ethers.utils.parseUnits("1", "18"), "CSmartBruceToken", "CSBT", 18, owner.address);
    await cErc20.deployed()

    // _supportMarket, 把 cToken 新增到 comptroller 的 markets
    await comptroller._supportMarket(cErc20.address)

    // send 100 erc20 tokens to user1
    await erc20.transfer(user1.address, USER1_INITAL_ERC20_BALANCE)

    return {
      ERC20_INITIAL_SUPPLY,
      owner,
      user1,
      user2,
      otherAccount,
      comptroller,
      simplePriceOracle,
      interestRateModel,
      erc20,
      cErc20,
    };
  }

  describe("compound loan feature", function () {
    it("Should mint/redeem the right amount CToken", async function () {
      const { user1, erc20, cErc20 } = await loadFixture(deployFixture);
      const mintAmount = ethers.utils.parseUnits("100", "18")

      // mint 100 CTokens 
      await erc20.connect(user1).approve(cErc20.address, mintAmount)
      await cErc20.connect(user1).mint(mintAmount)
      expect(await cErc20.balanceOf(user1.address)).to.equal(ethers.utils.parseUnits("100", "18"));

      // redeem 100 ERC20 Tokens
      await cErc20.connect(user1).redeem(mintAmount)
      expect(await erc20.balanceOf(user1.address)).to.equal(mintAmount);
    });
  });
});
