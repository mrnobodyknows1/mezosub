// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {MockMUSD} from "../test/mocks/MockMUSD.sol";

/// @notice Deploys MerchantRegistry + SubscriptionManager, allowlists MUSD, optionally grants KEEPER_ROLE and
///         writes deployments/<chainId>.json.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  required. Becomes DEFAULT_ADMIN_ROLE on both contracts.
///   KEEPER_ADDRESS        optional. Granted KEEPER_ROLE.
///   MIN_INTERVAL          optional, default 300 (seconds).
///   MUSD_ADDRESS          optional, default Mezo testnet MUSD.
///   DEPLOY_MOCK_MUSD      optional, local anvil only (chainid 31337): deploy a MockMUSD instead and mint
///                         1,000,000 to the deployer.
///
/// Mezo testnet:
///   forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --legacy --slow
///   node script/record-deployment.mjs 31611
contract Deploy is Script {
    address internal constant MUSD_TESTNET = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address keeper = vm.envOr("KEEPER_ADDRESS", address(0));
        uint256 minIntervalRaw = vm.envOr("MIN_INTERVAL", uint256(300));
        require(minIntervalRaw > 0 && minIntervalRaw <= 366 days, "MIN_INTERVAL out of range");
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 minInterval = uint32(minIntervalRaw);
        bool mockMusd = vm.envOr("DEPLOY_MOCK_MUSD", false);
        address musd = vm.envOr("MUSD_ADDRESS", MUSD_TESTNET);
        uint256 deployBlock = block.number;

        string[] memory txs = new string[](5);
        uint256 t;

        vm.startBroadcast(pk);

        if (mockMusd) {
            require(block.chainid == 31337, "DEPLOY_MOCK_MUSD is for local anvil only");
            MockMUSD m = new MockMUSD();
            m.mint(deployer, 1_000_000e18);
            musd = address(m);
            txs[t++] = "MockMUSD.create+mint";
        } else {
            require(musd.code.length > 0, "MUSD_ADDRESS has no code on this chain");
        }

        MerchantRegistry registry = new MerchantRegistry(deployer);
        txs[t++] = "MerchantRegistry.create";
        SubscriptionManager manager = new SubscriptionManager(address(registry), deployer, minInterval);
        txs[t++] = "SubscriptionManager.create";
        manager.setTokenAllowed(musd, true);
        txs[t++] = "SubscriptionManager.setTokenAllowed(MUSD)";
        if (keeper != address(0)) {
            manager.grantRole(manager.KEEPER_ROLE(), keeper);
            txs[t++] = "SubscriptionManager.grantRole(KEEPER_ROLE)";
        }

        vm.stopBroadcast();

        string[] memory steps = new string[](t);
        for (uint256 i = 0; i < t; ++i) {
            steps[i] = txs[i];
        }

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "registry", address(registry));
        vm.serializeAddress(k, "manager", address(manager));
        vm.serializeAddress(k, "musd", musd);
        vm.serializeAddress(k, "keeper", keeper);
        vm.serializeUint(k, "minInterval", minInterval);
        vm.serializeUint(k, "deployBlock", deployBlock);
        vm.serializeAddress(k, "deployer", deployer);
        string memory json = vm.serializeString(k, "txs", steps);

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console.log("registry", address(registry));
        console.log("manager ", address(manager));
        console.log("musd    ", musd);
        console.log("written ", path);
    }
}
