// 테스트 준비물: «관리자가 이미 사용을 허용해 둔» 상태로 만든다.
// 구독은 관리자 허용이 있어야 되는데, 허용 자체를 보는 테스트(osiri-admin-grants)가 아닌 곳은 이걸 깔고 시작한다.
import type { Catalog } from "../apps/server/src/osiri/store.ts";

export function grantOnSubscribe(catalog: Catalog) {
  const subscribe = catalog.subscribe.bind(catalog);
  catalog.subscribe = async (owner, packageId, options) => {
    await catalog.setGrant(owner, packageId, true);
    return subscribe(owner, packageId, options);
  };
}
