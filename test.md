
Kafka를 운영하면서 발생했던 이슈를 해결했던 경험을 공유해보도록 하겠습니다


## 이슈


---


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/abcf7384-e11a-4827-8c12-0ced9bdd7b96/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161130Z&X-Amz-Expires=3600&X-Amz-Signature=5d65eff4c75644ef8db9b01e5189724581cd50d068ccfc2dbf5a8e6d251e6df2&X-Amz-SignedHeaders=host&x-id=GetObject)


어느날 cs에서 급하게 찾는 연락이 왔습니다.


**다수의 회원이 서비스에서 제공하는 이벤트 쿠폰은 등록하지 못하는 일이 발생**했습니다.


처음에는 단순히 쿠폰에 문제가 있겠지하고 에러로그를 살펴보는데 


응…? **2시간여 동안 회원가입한 데이터가 존재하지 않았던 것**입니다. 


## 배경


---


현재 회원가입 플로우는 다음과 같습니다. 


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/6a107248-29a8-44f2-b941-3417034f55ca/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161130Z&X-Amz-Expires=3600&X-Amz-Signature=ab10f03dcc9eaebcb26f10b967cb5efaa3b08afd0a2d3abb03f0d88c33c0da30&X-Amz-SignedHeaders=host&x-id=GetObject)

1. 계정 서비스는 사용자에게 회원가입 요청을 받음
2. 계정 서비스는 회원가입 처리후 자동 로그인
3. 계정 서비스는 카프카 브로커에게 회원가입 이벤트 전송
4. 베이비페이스 서비스는 카프카 이벤트를 수신하여 회원데이터 저장

**메인 DB에 회원정보가 저장되지 않았다는 것**은 아래 2경우가 가장 유력했는데요

1. 계정 서비스에서 데이터 유실
2. 카프카에서 데이터 유실

계정 DB를 살펴본 결과 **계정 DB의 회원정보는 잘 저장이 된 것을 확인**했습니다. 


그렇다면 카프카에서 문제가 발생했다는 것인데, 운영서버 카프카 브로커는 3대로 구동하여 메세지가 잘 복제되었다면 브로커 몇개가 다운되어도 잘 동작했을 것이라 판단했습니다.


먼저 카프카를 먼저 살펴보았습니다.


## 원인 파악 


---


### 1. 카프카 구동 확인


운영 서버에는 총 3대의 카프카 브로커가 존재합니다. 각각의 브로커에 접근하여 모두 구동 중인지를 확인해보았습니다. 


```sql
ps -ef | grep kafka
```


결과는 총 3대의 브로커 중 **1번 카프카 서버가 다운된 상태였습니다**. 


하지만 카프카가 다운 되더라도 다른 브로커에 복제가 되어 이벤트를 수신할 수 있을텐데 왜 동작하지 않는지 의문이었습니다.


그래서 먼저 topic의 설정값을 먼저 살펴보기로 했습니다. 


회원가입 topic 설정에서 leader partition, replicationFactor, Isr등을 먼저 확인해보겠습니다.


### 2. topic 확인


```sql
./bin/kafka-topics.sh --zookeeper localhost:2181 --topic account_event --describe

**Topic:account_event**
PartitionCount:1        ReplicationFactor:1     Configs:
Topic: account_event    Partition: 0    Leader: 1       Replicas: 1     Isr: 1
```


<details>
  <summary>--zookeeper</summary>

- /bin/kafka-topics.sh에서 사용
- _`--boostrap-server`_ : 브로커에 바로 연결할 때 사용
- _`--zookeeper`_ : 주키퍼에 연결할 때 사용 (_deprecated_)


  </details>


**회원가입 topic을 보면 Leader partition, Replicas 모두 1번 카프카에만 존재했습니다.**


즉, **메세지가 복제되지도 않고 리더 파티션이 다운**되면 **메세지를 받을 방법이 없습니다**.


1번 카프카가 다운되었기 때문에 다운 기간동안 회원가입을 못했던 것이었습니다.


먼저 **왜 이런 일이 발생했는지 생각해보면 기존에 topic을 Publisher로 자동으로 생성했기 때문에 브로커에서 설정한 기본 옵션으로 토픽을 생성하게 됩니다.** 


그럼 언제부터 다운되었는지 한번 살펴보겠습니다.


### 3. commit log 확인


```java
./bin/kafka-run-class.sh kafka.tools.DumpLogSegments --deep-iteration --files ../kafka-logs/account_event-0/00000000000000052262.log
Dumping ../kafka-logs/account_event-0/00000000000000052262.log
```


```java
| offset: 52659 CreateTime: **1664956976908** keysize: -1 valuesize: 157 sequence: -1 headerKeys: []
baseOffset: 52660 lastOffset: 52660 count: 1 baseSequence: -1 lastSequence: -1 producerId: -1 producerEpoch: -1 partitionLeaderEpoch: 3 isTransactional: false isControl: false position: 90289 CreateTime: 1664965080597 size: 229 magic: 2 compresscodec: NONE crc: 428458902 isvalid: true
| offset: 52660 CreateTime: **1664965080597** keysize: -1 valuesize: 159 sequence: -1 headerKeys: []
baseOffset: 52661 lastOffset: 52661 count: 1 baseSequence: -1 lastSequence: -1 producerId: -1 producerEpoch: -1 partitionLeaderEpoch: 3 isTransactional: false isControl: false position: 90518 CreateTime: 1664965464265 size: 223 magic: 2 compresscodec: NONE crc: 2949796221 isvalid: true
```


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/0c770232-dcea-4013-ad13-3786208da741/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161133Z&X-Amz-Expires=3600&X-Amz-Signature=9f19c567a929999189a16af5d2e9db12c4e7c6875ef36802bb16b73dfa6b1ac2&X-Amz-SignedHeaders=host&x-id=GetObject)

![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/46ee04f9-e700-4747-9508-4e2cc71d7321/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161133Z&X-Amz-Expires=3600&X-Amz-Signature=9344321fd4f381f04e22bf2df94e866913a256b5926792f64ff2392d460ea6c9&X-Amz-SignedHeaders=host&x-id=GetObject)


카프카는 commit하는 시점에 CreateTime을 생성하는데 마지막으로 commit된 로그를 확인해보겠습니다. 


**10월 22일 오후 5시부터 복구 시점인 7시 18분까지 2시간여 동안 commit되지 않은 것을 알 수 있었습니다.**  


`server.log`를 살펴봐도 실제 운영시간을 알 수 있습니다.


```java
vim server.log.2022-10-05-17 
```


```java
[2022-10-05 17:05:39,869] INFO [GroupMetadataManager brokerId=1] Removed 0 expired offsets in 0 milliseconds. (kafka.coordinator.group.GroupMetadataManager)
```


**실제로 17시 5분부터 서버가 다운**되어있었습니다. 그렇다면 왜 서버가 다운되었을까요?


### 4. Kafka 1호기 서버 다운 원인 확인


결론적으로는 카프카에서는 에러 로그를 발견할 수 없었습니다. 


예상되는 이슈는 **Failed to clean up log for __consumer_offsets** 에러입니다. 

- 카프카 로그가 기본 설정인 _`/tmp`_에 존재할 때 발생하는 에러
- 카프카 데이터를 retention 주기만큼 보관하다가 cleaner가 삭제.
- 해당 이슈는 서버가 _`/tmp`_ 디렉토리를 자동으로 비울 때 발생
- 삭제할 로그 파일이 존재하지 않는 경우
- 하지만 우리 서버는 home 디렉토리에 로그 파일이 있으므로 해당 이슈는 아님
- 또한 로그 파일은 _`/tmp`_에 저장되지 않음

현재 이슈 복원을 할 수 없으므로 나중을 대비해 모니터링이나 로그의 필요성을 느끼게 되었습니다.


## 긴급 조치


---


일단 회원가입한 사용자의 정보는 계정 DB와 동기화를 해야했기 때문에 아래와 같이 조치하였습니다.


### **카프카 이벤트 수동 전송**


다행히 계정 서비스의 데이터베이스에는 회원정보가 잘 담겨 있어 정보들을 조합한 후 **수동으로 카프카에 데이터를 전송**했습니다.


카프카가 다운되었던 2시간동안의 데이터를 쿼리하여 메세지를 생성한 후 전달하여 동기화 했습니다. 


다행히 약 50건 정도의 데이터만 유실된 상황이라 빠르게 조치할 수 있었습니다.


```java
{
		**"accountId": 260939,
    "group": "account",
    "email": "1234@hanmail.net",
    "accountEvent": "SIGN_UP",**
    "properties": {
        **"role": "USER",**
        **"name": "이지원",**
        **"id": "12345678"**
	  }
}
```


## **후속 조치**


---


단기적으로는 위와 같이 조치를 하긴했으나 **장기적으로 카프카를 운영**할 때, **적절한 설정과 모니터링이 필요**했습니다


### 1. 모니터링


**카프카의 단점이라면 공식적으로 제공하는 UI툴이 없다는 것**입니다.


시중에 여러가지 UI 툴들이 있지만 그중에 아래 3가지를 후보로 선정했습니다. 

- UI for Apache Kafka
- Confluent
- Conduktor

![](https://github.com/schooldevops/kafka-tutorials-with-kido/blob/main/imgs/ui_tools_kafka.png?raw=true)


결론적으로는 **UI for Apache kafka**를 다음과 같은 이유로 선택하게 되었습니다.

- 무료
- 가독성이 좋고 유연한 UI
- 대부분의 서비스를 지원
- 현재도 활발히 개발 진행 중

Confluent CC나 Conducktor 같은 UI 툴들이 제공하는 기능들이 많이 부족하거나 비용이 들었기 때문에 UI for Apache Kafka도 적은 기능이었지만 현재 기능으로도 충분히 모니터링 가능하다 판단했습니다. 현재도 꾸준히 개발을 하는 UI 툴이기에 Pinpoint와 함께 조금씩 업데이트해 나가면 더 잘 활용할 수 있을 것이라 생각했습니다.


### 2. 카프카 생성 시 기본 옵션 변경


현재 **카프카 토픽 생성 시 자동생성은 다음과 같습니다.**

- **replicasFactor = 1** : replicas 1개로 복제 안됨
- **partition = 1** : 1번 브로커에만 파티션 존재
- **isr = 1** : 1번 파티션만 데이터 동기화

```markdown
**account_event** 
- partition: 1
- replicas: 1
- isr: 1 (leader partition: 1)
```


이러한 설정은 **고가용성을 보장하는 카프카를 제대로 활용하지 못하게 됩니다**. 


회원가입 이벤트는 매우 중요한 데이터이므로 성능보다는 **안정성을 고려한 설정**이 필요합니다.

- 파티션은 적어도 2개 이상 (2대 이상의 인스턴스를 사용하기 때문)
- 모든 브로커에 메세지를 복제
- 모든 팔로우 파티션이 리더 파티션 후보가 되어야 함
- 메세지가 리더 파티션과 팔로우 파티션에 저장됨을 보장

그럼 각각의 설정을 해보겠습니다


### 2-1. Topic


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/3e4dff72-41e6-4f4c-9458-b669e9182397/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=6f142b03420edc172b4b59da3bf2c0726e48d9e0438c7381a4fb165b243b59b6&X-Amz-SignedHeaders=host&x-id=GetObject)


**partition = 2** : 파티션을 2대로 증가

- **파티션과 컨슈머 개수**는 **병렬 처리 성능**에 중요한 역할
- 컨슈머가 2개인데 파티션이 하나라면 나머지 하나의 컨슈머는 idle 상태가 된다

파티션을 증가시킬 때 몇가지 주의 사항이 있습니다.


첫번째, **파티션의** **개수는 늘릴 수는 있지만 줄일 수는 없습니다**. 


그래서 **파티션은 필요한 만큼만 늘리는게 좋습니다**. 


회원가입 토픽은 현재는 2대의 서버만 사용하므로 1대를 추가적으로 늘렸습니다.


두번째, 메세지의 키가 존재한다면 파티션 변경 시, **메세지 키의 순서를 보장받지 못합니다**. 


카프카는 메세지 키 해시값으로 파티션을 할당합니다. 


파티션을 증가시키면 할당할 파티션의 값도 변경되어 컨슈머가 특정 메세지 키의 순서로 보장받지 못합니다.


회원가입 데이터는 **순서가 중요하지 않으므로** 순서를 고려하지 않고 파티션을 증가할 수 있습니다


kafka-topics.sh를 사용하여 파티션 하나를 추가해보겠습니다.


```java
./bin/kafka-topics.sh --bootstrap-server kafka1.alethio.io:9092 --topic account_event --alter --partitions 2
```


```java
./bin/kafka-topics.sh --zookeeper localhost:2181 --topic account_event --describe
Topic:account_event     PartitionCount:2        ReplicationFactor:1     Configs:
        Topic: account_event    Partition: 0    Leader: 1       Replicas: 1     Isr: 1
        Topic: account_event    Partition: 1    Leader: 2       Replicas: 2     Isr: 2
```


아래처럼 파티션이 잘 추가된 것을 볼 수 있습니다.


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/41ff4d4d-0dfa-41c2-a3ee-955a8f9b92be/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=b9bc517e440311d6f045d6efac513899238772071e54703a1ccd9a1754fdf71f&X-Amz-SignedHeaders=host&x-id=GetObject)


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/571b332d-5cb2-49a8-a352-7ba9e450f1d2/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=616c0e4bda6ca53d98af7348d6f7cc7ce82d863821f66b35f712973823770200&X-Amz-SignedHeaders=host&x-id=GetObject)


파티션을 2개 증가시켜서 보이는 변경사항들이 있는데요. 


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/19e4d893-c5d5-483b-8623-3e1f7da12fb1/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=72d4834217e6cb41418320218f6b1559247cc86fcd7080a5803e2f5930618b42&X-Amz-SignedHeaders=host&x-id=GetObject)


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/571b332d-5cb2-49a8-a352-7ba9e450f1d2/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=616c0e4bda6ca53d98af7348d6f7cc7ce82d863821f66b35f712973823770200&X-Amz-SignedHeaders=host&x-id=GetObject)


추가된 파티션을 기준으로 설명해보겠습니다.


Leader: 2

- 추가된 파티션의 리더 파티션은 2번 카프카
- 즉, Partition 1번의 메세지는 오직 2번 카프카로만 데이터를 보낼 수 있습니다.

Replicas: 2

- 추가된 파티션의 복사본이 2번 카프카에 존재
- 현재 ReplicationFactor가 1이므로 리더 파티션에만 데이터가 존재하므로 복사본도 2번 카프카에 있다고 할 수 있습니다.

Isr: 2

- ISR은 **리더와 팔로우 파티션의 데이터가 싱크된 상태**를 말합니다.
- 싱크된 상태는 **리더와 팔로우 파티션의 데이터가 복제 즉,** **offset이 같을 때**를 말합니다.
- ISR은 다른 말로는 **리더 파티션이 될 수 있는 카프카 브로커**를 말합니다. 왜냐면 데이터가 모두 싱크된 상태이기 때문입니다.
- 현재는 ReplicationFactor가 1이므로 다른 파티션에 복제가 될 수 없으므로 2번 카프카만이 리더 파티션이 될 수 있습니다.

다음으로는 replicasFactor를 변경해보겠습니다.


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/fbde80fd-ef38-4528-9376-1b5196346272/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=27e374cb97bd040b533a5717b2575b60b182c9d4ab5e0fed9533397f5237e432&X-Amz-SignedHeaders=host&x-id=GetObject)


**replicasFactor = 3** : 브로커 3개로 운영중이니 replicas는 기본 3개로 설정


replicasFactor라는 옵션은 존재하지 않고 대신 `kafka-reassign-partitions.sh`을 이용하여 파티션 개수를 늘려주면 됩니다.


설정 방법은 다음과 같습니다.

1. JSON 파일에 대상 토픽의 파티션에 어떤 카프카 브로커에 복제할 것인지를 명시합니다.
2. kafka-reassign-partitions.sh의 `—reassignment-json-file` 옵션으로 해당 설정을 읽어들입니다.

만약 파티션에 3대의 브로커 모두 복제되었다면 replicasFactor는 자동으로 3으로 증가됩니다.


replicasFactor 설정을 해보겠습니다. 먼저 json 설정 파일을 생성합니다.


```java
// rf.json
{
	"version":1,
	"partitions":[
	    {"topic":"account_event","partition":0,"replicas":[1,2,3]},
	    {"topic":"account_event","partition":1,"replicas":[1,2,3]} // 2,3만 하면 덮어씌워버린다. 1은 제외
	]
}
```


주의할 점은 **replicas에 [1,2,3]번 브로커 모두 지정**해줘야 한다는 점입니다. 


현재 브로커 1번에 파티션이 있다고 해서 [2,3]번만 업데이트 해버리면 [2,3]번 브로커에만 replicas가 생겨버립니다. 


그래서 [1,2,3] 번 모두 업데이트를 해야합니다


```java
bin/kafka-reassign-partitions.sh --zookeeper localhost:2181 --reassignment-json-file rf_account_event.json --execute
```


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/2f6c84dd-0986-47e2-a5af-754c15863fca/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=49cb4e394b0d5243a9315913b7f511d0c7a2cffa44103f22ba84cb26dd37967c&X-Amz-SignedHeaders=host&x-id=GetObject)


위 커맨드를 실행하면 성공적으로 파티션이 할당되었음을 볼 수 있습니다.


```java
Topic:account_event     PartitionCount:2        ReplicationFactor:3     Configs:
        Topic: account_event    Partition: 0    Leader: 2       Replicas: 1,2,3 Isr: 3,2,1
        Topic: account_event    Partition: 1    Leader: 1       Replicas: 1,2,3 Isr: 3,1,2
```


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/737cc664-758b-43ed-83d7-6aa981820a14/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=8b2b2b7c1a6cbb94e0ea7769b8c64b0168bd85492d88c38a8bab56fbaceaf370&X-Amz-SignedHeaders=host&x-id=GetObject)


이제 토픽을 확인해보면 ReplicasFactor가 3으로 증가했음을 알 수 있습니다.


Replicass: 1, 2, 3

- 1, 2, 3번 브로커에 복제본 존재

Isr: 1, 2, 3

- 1, 2, 3번 브로커에 토픽이 모두 싱크
- 1, 2, 3번 브로커가 모두 리더 파티션이 될 수 있음

![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/4339f1b1-9e24-4d50-980c-d980dbd4bb5e/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=ddfc79d6cd90776774a375128b05df26ca23e3c5456c4a2984d9e8d337a3ea99&X-Amz-SignedHeaders=host&x-id=GetObject)


이제 발생한 이슈처럼 1번 브로커가 다운되어도 (리더 파티션) 모든 브로커에 이미 이벤트가 복제되어 있고 브로커 3번이 리더 파티션으로 선출될 수 있기 때문에 장애없이 운영할 수 있습니다.


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/1a697ac0-a774-43a1-b488-e5ccc37945b6/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=3ef2d5400b6065d1a57ef23a8c463b8c23a5b3c954ebf292857e275a7255d62d&X-Amz-SignedHeaders=host&x-id=GetObject)


참고로 **리더 파티션은 복제가 되었다고 다 되는 것은 아닙니다**.


**팔로우 파티션이 리더 파티션으로 부터 데이터를 복제하는데 시간이 걸립니다**. 


리더 파티션에서 새로운 레코드가 추가되어 offset이 증가하면, 팔로우 파티션은 offset의 차이를 감지하고 리더 파티션의 데이터를 복제합니다.  이 과정에서 **시간차로 offset의 차이가 생깁니다**. 그래서 리더 파티션은 `replicas.lag.time.max.ms`의 주기로 팔로우 파티션이 데이터를 복제했는지 확인합니다. 만약 해당 시간만큼 데이터를 가져가지 않는다면 해당 **팔로워 파티션에 문제가 생긴 것으로 보고 ISR에서 제외**합니다. 


즉, **일정 시간안에 리더 파티션의 데이터 복제를 보장, offset이 같은 팔로워 파티션**이 리더 파티션이 될 수 있습니다. (물론 ISR이 아닌 파티션도 리더로 선출될 수 있습니다. 범위가 아니니 생략하도록 하겠습니다)


### 2-2. Producer


회원가입 이벤트와 같이 안정성이 중요한 데이터는 **Producer가 전송할 때 리더 파티션과 팔로워 파티션에 데이터가 모두 잘 저장되었는지 확인**할 수 있습니다.


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/3563247e-e977-4462-864d-5a9069823a1e/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=925f92c751edad13a76484c123dfd6d200d741e99e8f5dad9ee58764833aad5c&X-Amz-SignedHeaders=host&x-id=GetObject)


**acks = all** : 리더 파티션과 팔로워 파티션에 모두 정상 적재되었는지 확인

- 1 : 리더 파티션에 데이터가 저장되면 전송 성공 (default)
- 0 : 전송 즉시 저장 여부 관계없이 성공
- -1, all : `min.insync.replicas` 개수에 해당하는 리더와 팔로워 파티션에 데이터가 저장되면 성공

**acks = all**은 리더와 팔로워 파티션 둘 다 확인하므로 **안정적**입니다. 


하지만 **파티션이 여러개라면 모두 다 확인해야하므로 속도가 느립니다**. 


정확히는 모든 리더와 팔로워가 아니라 ISR 범위 내에서의 파티션을 말합니다.


여기서 `min.insync.replicas` 개수가 나오는데 주의해서 사용해야 합니다.


![](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/552a4b98-585c-4fca-bb03-31ec40170d2f/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20221211%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20221211T161131Z&X-Amz-Expires=3600&X-Amz-Signature=909f14c8e5b4dcb66e69bba32decab0eb4341742d71fc6373cd6957ea6296879&X-Amz-SignedHeaders=host&x-id=GetObject)


min.insync.replicas = 2 : 브로커가 3개이므로 1개의 브로커가 종료되어도 2개에 최소한 복제가 가능


min.insync.replicas는 **동기화될 최소 브로커 개수**를 말합니다.


예를들어 min.insync.replicas가 3이면 3대의 브로커의 데이터가 싱크되어야 합니다. 


하지만 3대 중 1대가 고장나면 어떻게 될까요?


3대가 동기화되어야 하는데 2대만 존재하므로 나머지 하나가 동기화 될때까지 프로듀서는 데이터를 기다리게 됩니다


그러면 해당 프로듀서는 **더 이상 데이터를 전송할 수 없게 됩니다**


그래서 min.insync.replicas = 2 면 **1대의 브로커에 장애에도 정상적으로  데이터를 전송**할 수 있는 최소 설정이 됩니다.


## 결론 


---


카프카 브로커의 장애로 메세지가 전달이 안되는 이슈를 해결하는 과정을 최대한 자세히 적어보았습니다.


토픽의 설정을 최대한 안정적으로 파티션에 복제가 되고 전달이 되도록 변경하였습니다.


ISR 범위에서 리더 파티션이 죽더라도 팔로워 파티션이 리더 파티션이 되어 지속적으로 메세지를 수신하도록 설정했습니다.


당연한 이야기지만 기본적으로 **카프카 토픽은 수동으로 생성**해야된다는 것을 다시 깨닫게 되었습니다. 


토픽은 기본적으로 성능보다 안정성이 중요한 경우 아래와 같이 설정하는게 좋을 것 같습니다. (브로커 3대 기준)


| topic              | producer                |
| ------------------ | ----------------------- |
| partition = 3      | acks = all              |
| replicasFactor = 3 | min.insync.replicas = 2 |


## Reference


---


[https://kafka.apache.org/22/documentation.html](https://kafka.apache.org/22/documentation.html)


[https://velog.io/@jwpark06/Kafka-시스템-구조-알아보기](https://velog.io/@jwpark06/Kafka-%EC%8B%9C%EC%8A%A4%ED%85%9C-%EA%B5%AC%EC%A1%B0-%EC%95%8C%EC%95%84%EB%B3%B4%EA%B8%B0)


[https://shinwusub.tistory.com/133](https://shinwusub.tistory.com/133)


[https://parkcheolu.tistory.com/196](https://parkcheolu.tistory.com/196)


[https://www.confluent.io/blog/kafka-listeners-explained/](https://www.confluent.io/blog/kafka-listeners-explained/)


[https://devocean.sk.com/blog/techBoardDetail.do?ID=163980](https://devocean.sk.com/blog/techBoardDetail.do?ID=163980)


[https://towardsdatascience.com/overview-of-ui-tools-for-monitoring-and-management-of-apache-kafka-clusters-8c383f897e80](https://towardsdatascience.com/overview-of-ui-tools-for-monitoring-and-management-of-apache-kafka-clusters-8c383f897e80)


[카프카를 debugging 가능한 상태로 설정](https://www.ibm.com/docs/en/cloud-paks/cp-biz-automation/19.0.x?topic=emitter-enabling-kafka-broker-trace) → cron으로 주기적으로 제거


[https://allg.tistory.com/65](https://allg.tistory.com/65)


[https://www.popit.kr/kafka-운영자가-말하는-topic-replication/](https://www.popit.kr/kafka-%EC%9A%B4%EC%98%81%EC%9E%90%EA%B0%80-%EB%A7%90%ED%95%98%EB%8A%94-topic-replication/)


[https://www.popit.kr/kafka-운영자가-말하는-replication-factor-변경/](https://www.popit.kr/kafka-%EC%9A%B4%EC%98%81%EC%9E%90%EA%B0%80-%EB%A7%90%ED%95%98%EB%8A%94-replication-factor-%EB%B3%80%EA%B2%BD/)


[https://docs.confluent.io/platform/current/platform-quickstart.html#ce-docker-quickstart](https://docs.confluent.io/platform/current/platform-quickstart.html#ce-docker-quickstart)


[https://www.baeldung.com/kafka-docker-connection](https://www.baeldung.com/kafka-docker-connection)


[https://log-laboratory.tistory.com/205](https://log-laboratory.tistory.com/205)


[https://dev.to/optnc/kafka-image-wurstmeister-vs-bitnami-efg](https://dev.to/optnc/kafka-image-wurstmeister-vs-bitnami-efg)

