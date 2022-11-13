// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import {CErc20} from "./compound/CErc20.sol";
import {FlashLoanReceiverBase, ILendingPoolAddressesProvider} from "./aave-v2/FlashLoanReceiverBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";

// Uncomment this line to use console.log
import "hardhat/console.sol";

contract FlashLoan is FlashLoanReceiverBase {
    address public owner;
    address public cTokenAddress;
    address public cTokenCollateral;
    address public borrowerAddress;
    address constant UNI_ADDRESS = 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984;
    address constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    ISwapRouter public immutable swapRouter;

    using SafeMath for uint256;

    constructor(
        ILendingPoolAddressesProvider _addressProvider,
        address _cTokenAddress,
        address _cTokenCollateral,
        address _borrowerAddress,
        ISwapRouter _swapRouter
    ) FlashLoanReceiverBase(_addressProvider) {
        owner = msg.sender;
        cTokenAddress = _cTokenAddress;
        cTokenCollateral = _cTokenCollateral;
        borrowerAddress = _borrowerAddress;
        swapRouter = _swapRouter;
    }

    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        {
            IERC20(assets[0]).approve(cTokenAddress, amounts[0]);

            uint errorCode = CErc20(cTokenAddress).liquidateBorrow(
                borrowerAddress,
                amounts[0],
                CErc20(cTokenCollateral)
            );

            require(errorCode == 0, "liquidateBorrow failed");
        }

        uint256 redeemErc20Token = IERC20(cTokenCollateral).balanceOf(
            address(this)
        );

        CErc20(cTokenCollateral).redeem(redeemErc20Token);

        TransferHelper.safeApprove(
            UNI_ADDRESS,
            address(swapRouter),
            redeemErc20Token
        );

        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter
            .ExactInputSingleParams({
                tokenIn: UNI_ADDRESS,
                tokenOut: USDC_ADDRESS,
                fee: 3000, // 0.3%
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: redeemErc20Token,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            });

        // The call to `exactInputSingle` executes the swap.
        uint256 amountOut = swapRouter.exactInputSingle(swapParams);

        // Approve the LendingPool contract allowance to *pull* the owed amount
        for (uint i = 0; i < assets.length; i++) {
            uint amountOwing = amounts[i].add(premiums[i]);
            IERC20(assets[i]).approve(address(LENDING_POOL), amountOwing); // payback to AAVE

            IERC20(assets[i]).transfer(owner, amountOut - amountOwing); // transfer to admin
        }

        return true;
    }

    function flashloan(address _asset, uint _amount) public {
        address receiverAddress = address(this);

        address[] memory assets = new address[](1);
        assets[0] = _asset; // USDC

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _amount;

        // 0 = no debt, 1 = stable, 2 = variable
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0;

        address onBehalfOf = address(this);
        bytes memory params = "";
        uint16 referralCode = 0;

        LENDING_POOL.flashLoan(
            receiverAddress,
            assets,
            amounts,
            modes,
            onBehalfOf,
            params,
            referralCode
        );
    }
}
